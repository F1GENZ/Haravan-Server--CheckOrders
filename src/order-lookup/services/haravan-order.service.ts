import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import axios, { AxiosError } from 'axios';
import * as crypto from 'crypto';

// ─── Types ───

interface HaravanOrder {
  id: number;
  order_number: number;
  name: string;
  phone: string;
  email: string;
  created_at: string;
  financial_status: string;
  fulfillment_status: string | null;
  total_price: string;
  currency: string;
  customer?: {
    phone?: string;
    default_address?: { phone?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  billing_address?: { phone?: string; [key: string]: unknown };
  shipping_address?: {
    phone?: string;
    address1?: string;
    city?: string;
    province?: string;
    [key: string]: unknown;
  };
  line_items?: Array<{
    title: string;
    quantity: number;
    price: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface HaravanOrdersResponse {
  orders?: HaravanOrder[];
}

const CACHE_PREFIX = 'haravan:checkorders:cache';
const DEFAULT_LOOKBACK_DAYS = 365;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGE_RETRIES = 3;
const DEFAULT_FALLBACK_LOOKBACK_DAYS = 3650;
const DEFAULT_FALLBACK_MAX_PAGES = 80;
const DEFAULT_CACHE_SECONDS = 180;
const DEFAULT_NEGATIVE_CACHE_SECONDS = 45;
const TELEMETRY_PREFIX = 'haravan:checkorders:telemetry';

type CachedLookup =
  | HaravanOrder[]
  | {
      orders?: HaravanOrder[];
      not_found?: boolean;
    };

type FetchOrdersResult = {
  orders: HaravanOrder[];
  pagesScanned: number;
};

/**
 * HaravanOrderService — Data Agent
 *
 * Handles communication with Haravan Omni API to fetch orders.
 * Implements caching, phone/order_code filtering (Haravan API
 * doesn't support these filters natively), and data normalization.
 */
@Injectable()
export class HaravanOrderService {
  private readonly logger = new Logger(HaravanOrderService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Look up orders by phone and/or order code.
   * Caches filtered lookup results briefly, then refetches on cache misses.
   */
  async lookupOrders(
    accessToken: string,
    storeId: string,
    phone?: string,
    orderCode?: string,
    maxOrders = 5,
  ): Promise<HaravanOrder[]> {
    const startedAt = Date.now();
    const normalizedPhone = phone ? this.normalizePhone(phone) : '';
    const normalizedCode = orderCode ? orderCode.replace(/^#/, '').trim() : '';
    const cacheKey = this.buildCacheKey(
      storeId,
      normalizedPhone,
      normalizedCode,
    );
    const cached = await this.redis.get<CachedLookup>(cacheKey);

    if (Array.isArray(cached) && cached.length > 0) {
      this.logger.debug(
        `Cache hit for store ${storeId} (${cached.length} orders)`,
      );
      await this.saveTelemetry(storeId, {
        cache_status: 'hit',
        result_count: cached.length,
        pages_scanned: 0,
        fallback_used: false,
        duration_ms: Date.now() - startedAt,
      });
      return cached.slice(0, maxOrders);
    }
    if (!Array.isArray(cached) && cached?.not_found) {
      await this.saveTelemetry(storeId, {
        cache_status: 'negative_hit',
        result_count: 0,
        pages_scanned: 0,
        fallback_used: false,
        duration_ms: Date.now() - startedAt,
      });
      return [];
    }
    if (!Array.isArray(cached) && Array.isArray(cached?.orders)) {
      await this.saveTelemetry(storeId, {
        cache_status: 'hit',
        result_count: cached.orders.length,
        pages_scanned: 0,
        fallback_used: false,
        duration_ms: Date.now() - startedAt,
      });
      return cached.orders.slice(0, maxOrders);
    }

    this.logger.debug(
      `Cache miss - fetching from Haravan API for store ${storeId}`,
    );
    const recentResult = await this.fetchOrdersFromHaravan(accessToken);
    const allOrders = recentResult.orders;
    let filtered = this.filterOrders(
      allOrders,
      normalizedPhone,
      normalizedCode,
    );
    let pagesScanned = recentResult.pagesScanned;
    let fallbackUsed = false;

    if (filtered.length === 0 && normalizedCode.length >= 4) {
      fallbackUsed = true;
      const fallbackLookbackDays = this.getPositiveConfig(
        'ORDER_LOOKUP_FALLBACK_LOOKBACK_DAYS',
        DEFAULT_FALLBACK_LOOKBACK_DAYS,
      );
      const fallbackMaxPages = this.getPositiveConfig(
        'ORDER_LOOKUP_FALLBACK_MAX_PAGES',
        DEFAULT_FALLBACK_MAX_PAGES,
      );
      this.logger.debug(
        `Fallback lookup for ${storeId} with lookback=${fallbackLookbackDays} days, pages=${fallbackMaxPages}`,
      );
      const deepResult = await this.fetchOrdersFromHaravan(
        accessToken,
        fallbackLookbackDays,
        fallbackMaxPages,
      );
      pagesScanned += deepResult.pagesScanned;
      filtered = this.filterOrders(
        deepResult.orders,
        normalizedPhone,
        normalizedCode,
      );
    }

    if (filtered.length > 0) {
      await this.redis.set(
        cacheKey,
        { orders: filtered },
        this.getPositiveConfig(
          'ORDER_LOOKUP_CACHE_SECONDS',
          DEFAULT_CACHE_SECONDS,
        ),
      );
    } else {
      await this.redis.set(
        cacheKey,
        { not_found: true },
        this.getPositiveConfig(
          'ORDER_LOOKUP_NEGATIVE_CACHE_SECONDS',
          DEFAULT_NEGATIVE_CACHE_SECONDS,
        ),
      );
    }

    await this.saveTelemetry(storeId, {
      cache_status: 'miss',
      result_count: filtered.length,
      pages_scanned: pagesScanned,
      fallback_used: fallbackUsed,
      duration_ms: Date.now() - startedAt,
    });
    return filtered.slice(0, maxOrders);
  }

  // ─── Private ───

  private normalizePhone(phone: string): string {
    let p = phone.replace(/[\s().-]/g, '');
    if (p.startsWith('+84')) p = '0' + p.slice(3);
    else if (p.startsWith('84') && p.length > 10) p = '0' + p.slice(2);
    return p;
  }

  private buildCacheKey(
    storeId: string,
    phone: string,
    orderCode: string,
  ): string {
    const raw = `${phone}:${orderCode}`.toLowerCase();
    const hash = crypto
      .createHash('sha256')
      .update(raw)
      .digest('hex')
      .slice(0, 16);
    return `${CACHE_PREFIX}:${storeId}:${hash}`;
  }

  private getPositiveConfig(name: string, fallback: number): number {
    const value = Number(this.configService.get<string>(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /**
   * Fetch recent orders from Haravan API.
   * Haravan doesn't support filtering by phone/order_number in query params,
   * so we fetch the most recent orders and filter in-app.
   */
  private async fetchOrdersFromHaravan(
    accessToken: string,
    lookbackDaysOverride?: number,
    maxPagesOverride?: number,
  ): Promise<FetchOrdersResult> {
    const lookbackDays =
      lookbackDaysOverride ??
      this.getPositiveConfig(
        'ORDER_LOOKUP_LOOKBACK_DAYS',
        DEFAULT_LOOKBACK_DAYS,
      );
    const maxPages =
      maxPagesOverride ??
      this.getPositiveConfig('ORDER_LOOKUP_MAX_PAGES', DEFAULT_MAX_PAGES);
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - lookbackDays);
    const createdAtMin = createdAt.toISOString();

    const allOrders: HaravanOrder[] = [];
    let pagesScanned = 0;
    const pageRetries = new Map<number, number>();
    let page = 1;
    while (page <= maxPages) {
      try {
        const url =
          `https://apis.haravan.com/com/orders.json` +
          `?created_at_min=${encodeURIComponent(createdAtMin)}` +
          `&limit=50&page=${page}`;

        const response = await axios.get<HaravanOrdersResponse>(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10_000,
        });

        pagesScanned++;
        const orders = response.data?.orders;
        if (!orders || orders.length === 0) break;

        allOrders.push(...orders);

        // If less than 50, no more pages
        if (orders.length < 50) break;
        page++;
      } catch (error: unknown) {
        if (axios.isAxiosError(error)) {
          const axErr = error as AxiosError;
          if (axErr.response?.status === 429) {
            const retries = (pageRetries.get(page) || 0) + 1;
            pageRetries.set(page, retries);
            if (retries > MAX_PAGE_RETRIES) {
              this.logger.warn(
                `Haravan rate limit retries exceeded on page ${page}`,
              );
              break;
            }
            // Rate limited — wait and retry
            const retryAfter =
              Number(axErr.response.headers['retry-after']) || 2;
            this.logger.warn(`Haravan rate limited, waiting ${retryAfter}s...`);
            await this.sleep(retryAfter * 1000);
            continue; // Retry same page
          }
          if (axErr.response?.status === 401) {
            this.logger.error('Haravan token expired or invalid');
            throw new Error('HARAVAN_TOKEN_INVALID');
          }
        }
        this.logger.error(
          'Failed to fetch orders from Haravan',
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
    }

    return { orders: allOrders, pagesScanned };
  }

  private async saveTelemetry(
    storeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.redis.set(
        `${TELEMETRY_PREFIX}:${storeId}:last`,
        { ...payload, at: new Date().toISOString() },
        7 * 24 * 3600,
      );
    } catch {
      // Telemetry must never block lookup.
    }
  }

  /**
   * Filter orders by phone and/or order code.
   * Since Haravan API doesn't support these filters, we do it in-app.
   */
  private filterOrders(
    orders: HaravanOrder[],
    phone: string,
    orderCode: string,
  ): HaravanOrder[] {
    return orders.filter((order) => {
      let phoneMatch = true;
      let codeMatch = true;

      if (phone) {
        const orderPhones = [
          order.phone,
          order.customer?.phone,
          order.customer?.default_address?.phone,
          order.billing_address?.phone,
          order.shipping_address?.phone,
        ]
          .filter(Boolean)
          .map((p) => this.normalizePhone(p as string));

        phoneMatch = orderPhones.some((p) => p === phone);
      }

      if (orderCode) {
        const code = orderCode.toLowerCase();
        const orderName = String(order.name || '')
          .replace(/^#/, '')
          .toLowerCase();
        const orderNum = String(order.order_number || '').toLowerCase();
        codeMatch = orderName === code || orderNum === code;
      }

      return phoneMatch && codeMatch;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
