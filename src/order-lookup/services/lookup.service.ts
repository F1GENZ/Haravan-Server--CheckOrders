import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StoreService, type StoreSettings } from './store.service';
import { HaravanOrderService } from './haravan-order.service';
import { MaskingService } from './masking.service';
import { RateLimitService } from './rate-limit.service';
import { HaravanService } from '../../haravan/haravan.service';
import type {
  OrderResult,
  LookupResponseDto,
} from '../dto/lookup-response.dto';
import * as crypto from 'crypto';
import axios from 'axios';

const LOG_PREFIX = 'haravan:checkorders:log';

const textValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
};

/**
 * LookupService — Core orchestration
 *
 * Ties together all services: validates input against store settings,
 * checks rate limits, calls Haravan API via HaravanOrderService,
 * applies masking/filtering, and logs lookups.
 */
@Injectable()
export class LookupService {
  private readonly logger = new Logger(LookupService.name);

  constructor(
    private readonly storeService: StoreService,
    private readonly haravanOrderService: HaravanOrderService,
    private readonly maskingService: MaskingService,
    private readonly rateLimitService: RateLimitService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => HaravanService))
    private readonly haravanService: HaravanService,
    @Optional()
    private readonly db?: PrismaService,
  ) {}

  /**
   * Main lookup endpoint logic.
   */
  async lookup(
    publicShop: string,
    phone: string | undefined,
    orderCode: string | undefined,
    clientIp: string,
    origin?: string,
    storeOrigin?: string,
    captchaToken?: string,
    proxyHost?: string,
  ): Promise<LookupResponseDto> {
    const normalizedPhone = phone ? this.normalizePhone(phone) : undefined;
    const normalizedOrderCode = orderCode
      ? String(orderCode).replace(/^#/, '').trim()
      : undefined;

    // 1. Identify store by public shop handle/domain.
    const store = await this.storeService.getStoreByPublicShop(publicShop);
    if (!store || !store.is_active) {
      return {
        success: false,
        error: 'invalid_shop',
        message: 'Không tìm thấy cửa hàng',
      };
    }

    // 1b. Validate browser/store origin against the registered shop domains.
    const validationOrigin = this.resolveValidationOrigin(
      origin,
      storeOrigin,
      proxyHost,
    );
    if (!validationOrigin) {
      return {
        success: false,
        error: 'origin_required',
        message: 'Không được phép truy cập',
      };
    }

    try {
      const originHost = new URL(validationOrigin).hostname.toLowerCase();
      if (originHost !== 'localhost' && originHost !== '127.0.0.1') {
        const allowedHosts = new Set(
          [
            store.shop_domain,
            store.custom_domain,
            ...(store.shop_domains || []),
          ]
            .filter(Boolean)
            .map((d) => this.normalizeDomain(String(d))),
        );
        if (!allowedHosts.has(this.normalizeDomain(originHost))) {
          this.logger.warn(
            `Origin mismatch: ${originHost} vs store ${store.shop_domain}`,
          );
          return {
            success: false,
            error: 'origin_mismatch',
            message: 'Không được phép truy cập',
          };
        }
      }
    } catch {
      return {
        success: false,
        error: 'origin_invalid',
        message: 'Không được phép truy cập',
      };
    }

    // 2. Get store settings
    const settings = await this.storeService.getSettings(store.org_id);
    if (!settings.widget_enabled) {
      return {
        success: false,
        error: 'widget_disabled',
        message: 'Widget đã bị tắt',
      };
    }

    // 3. Validate input against lookup method
    const validationError = this.validateInput(
      normalizedPhone,
      normalizedOrderCode,
      settings,
    );
    if (validationError) {
      return {
        success: false,
        error: 'invalid_request',
        message: validationError,
      };
    }

    // 4. Check rate limit
    const rateResult = await this.rateLimitService.check(
      clientIp,
      store.org_id,
    );
    if (rateResult.blocked) {
      await this.logLookup(
          store.org_id,
          clientIp,
          normalizedPhone,
          normalizedOrderCode,
          0,
          'rate_limited',
        );
      return {
        success: false,
        error: 'rate_limited',
        message: 'Bạn đã tra cứu quá nhiều lần. Vui lòng thử lại sau.',
      };
    }

    if (rateResult.require_captcha) {
      const captchaValid = await this.verifyCaptcha(captchaToken, clientIp);
      if (!captchaValid) {
        await this.logLookup(
          store.org_id,
          clientIp,
          normalizedPhone,
          normalizedOrderCode,
          0,
          'captcha_required',
        );
        return {
          success: false,
          error: 'captcha_required',
          message: 'Vui lòng xác minh bảo mật rồi thử lại.',
          require_captcha: true,
        };
      }
    }

    // 5. Call Haravan API (with cache)
    try {
      let accessToken = store.access_token;
      try {
        accessToken = await this.haravanService.resolveAccessToken(
          store.org_id,
        );
      } catch (tokenError) {
        this.logger.warn(
          `Using stored token for ${store.org_id}: ${
            tokenError instanceof Error
              ? tokenError.message
              : String(tokenError)
          }`,
        );
      }

      const orders = await this.haravanOrderService.lookupOrders(
        accessToken,
        store.org_id,
        normalizedPhone,
        normalizedOrderCode,
        settings.max_orders,
      );

      if (!orders || orders.length === 0) {
        await this.logLookup(
          store.org_id,
          clientIp,
          normalizedPhone,
          normalizedOrderCode,
          0,
          'not_found',
        );
        return {
          success: false,
          error: 'not_found',
          message: 'Không tìm thấy đơn hàng phù hợp.',
        };
      }

      // 6. Transform, mask, and filter
      const results = orders.map((order) => {
        const normalized = this.normalizeOrder(order);
        const masked = this.maskingService.applyMasking(normalized, settings);
        const filtered = this.maskingService.filterFields(
          masked,
          settings.visible_fields,
        );
        return filtered as unknown as OrderResult;
      });

      // 7. Log successful lookup
      await this.logLookup(
        store.org_id,
        clientIp,
        normalizedPhone,
        normalizedOrderCode,
        results.length,
        'success',
      );

      return {
        success: true,
        orders: results,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Lookup failed for store ${store.org_id}: ${msg}`);

      if (msg === 'HARAVAN_TOKEN_INVALID') {
        return {
          success: false,
          error: 'store_error',
          message: 'Lỗi kết nối cửa hàng. Vui lòng liên hệ chủ shop.',
        };
      }

      await this.logLookup(
        store.org_id,
        clientIp,
        normalizedPhone,
        normalizedOrderCode,
        0,
        'error',
      );
      return {
        success: false,
        error: 'server_error',
        message: 'Có lỗi xảy ra. Vui lòng thử lại.',
      };
    }
  }

  // ─── Private ───

  private validateInput(
    phone: string | undefined,
    orderCode: string | undefined,
    settings: StoreSettings,
  ): string | null {
    switch (settings.lookup_method) {
      case 'phone':
        if (!phone) return 'Vui lòng nhập số điện thoại';
        break;
      case 'order_code':
        if (!orderCode) return 'Vui lòng nhập mã đơn hàng';
        break;
      case 'phone_or_code':
        if (!phone && !orderCode)
          return 'Vui lòng nhập số điện thoại hoặc mã đơn hàng';
        break;
      case 'phone_and_code':
      default:
        if (!phone || !orderCode)
          return 'Vui lòng nhập số điện thoại và mã đơn hàng';
        break;
    }
    return null;
  }

  private normalizeDomain(domain: string): string {
    return domain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .trim();
  }

  private normalizePhone(phone: string): string {
    let value = String(phone || '').replace(/[\s().-]/g, '');
    if (value.startsWith('+84')) value = '0' + value.slice(3);
    else if (value.startsWith('84') && value.length > 9)
      value = '0' + value.slice(2);
    return value;
  }

  private resolveValidationOrigin(
    origin?: string,
    storeOrigin?: string,
    proxyHost?: string,
  ): string | null {
    if (!origin) return null;

    const originHost = this.getHostname(origin);
    if (!originHost) return null;

    if (
      originHost === 'localhost' ||
      originHost === '127.0.0.1' ||
      originHost === this.normalizeDomain(proxyHost || '') ||
      this.getTrustedProxyHosts().has(originHost)
    ) {
      return storeOrigin || origin;
    }

    return origin;
  }

  private getHostname(origin: string): string | null {
    try {
      return new URL(origin).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private getTrustedProxyHosts(): Set<string> {
    const hosts = [
      process.env.API_BASE_URL,
      process.env.FRONTEND_URL,
      process.env.WIDGET_PUBLIC_URL,
      process.env.WIDGET_API_URL,
    ]
      .map((value) => this.getHostname(value || ''))
      .filter((value): value is string => Boolean(value));
    return new Set(hosts);
  }

  private async verifyCaptcha(
    captchaToken: string | undefined,
    clientIp: string,
  ): Promise<boolean> {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret || !captchaToken) return false;

    try {
      const body = new URLSearchParams({
        secret,
        response: captchaToken,
        remoteip: clientIp,
      });
      const response = await axios.post<{ success?: boolean }>(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 5000,
        },
      );
      return response.data?.success === true;
    } catch (error) {
      this.logger.warn(
        `CAPTCHA verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private normalizeOrder(
    order: Record<string, unknown>,
  ): Record<string, unknown> {
    const financialStatus = textValue(order.financial_status) || 'pending';
    const fulfillmentStatus = textValue(order.fulfillment_status) || null;

    const statusMap: Record<string, { text: string; class: string }> = {
      paid: { text: 'Đã thanh toán', class: 'success' },
      pending: { text: 'Chờ thanh toán', class: 'pending' },
      refunded: { text: 'Đã hoàn tiền', class: 'cancelled' },
      voided: { text: 'Đã hủy', class: 'cancelled' },
      partially_paid: { text: 'Thanh toán một phần', class: 'pending' },
      partially_refunded: { text: 'Hoàn tiền một phần', class: 'pending' },
    };

    const fulfillmentMap: Record<string, string> = {
      fulfilled: 'Đã giao hàng',
      partial: 'Giao một phần',
      notfulfilled: 'Chưa giao hàng',
      cancelled: 'Đã hủy giao hàng',
      canceled: 'Đã hủy giao hàng',
      restocked: 'Đã hủy giao hàng',
    };

    const status = statusMap[financialStatus] || {
      text: financialStatus,
      class: 'pending',
    };

    const fmtPrice = (v: unknown) =>
      v ? Number(v).toLocaleString('vi-VN') + '₫' : undefined;
    const fmtDate = (v: unknown) =>
      v
        ? new Date(v as string).toLocaleString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : undefined;
    const str = (v: unknown) => textValue(v);

    // ─── Customer ───
    const customer = order.customer as Record<string, unknown> | undefined;
    const customerDefaultAddress = customer?.default_address as
      | Record<string, unknown>
      | undefined;
    const shipping = order.shipping_address as
      | Record<string, unknown>
      | undefined;
    const billing = order.billing_address as
      | Record<string, unknown>
      | undefined;

    const customerName =
      [
        str(customer?.last_name) || str(shipping?.last_name),
        str(customer?.first_name) || str(shipping?.first_name),
      ]
        .filter(Boolean)
        .join(' ') || undefined;

    // ─── Addresses ───
    const buildAddress = (addr: Record<string, unknown> | undefined) => {
      if (!addr) return undefined;
      return [
        str(addr.address1),
        str(addr.ward),
        str(addr.district),
        str(addr.city),
        str(addr.province),
        str(addr.country),
      ]
        .filter(Boolean)
        .join(', ');
    };

    // ─── Line items ───
    const rawItems = order.line_items as
      | Array<Record<string, unknown>>
      | undefined;
    const lineItems = rawItems?.map((item) => {
      const imageObj = item.image as Record<string, unknown> | undefined;
      return {
        title: str(item.title) || '',
        variant_title: str(item.variant_title),
        sku: str(item.sku),
        vendor: str(item.vendor),
        barcode: str(item.barcode),
        variant_id: Number(item.variant_id || 0) || undefined,
        product_id: Number(item.product_id || 0) || undefined,
        product_url: str(item.url),
        quantity: Number(item.quantity || 1),
        price: fmtPrice(item.price),
        total: fmtPrice(Number(item.price || 0) * Number(item.quantity || 1)),
        weight: item.grams
          ? (Number(item.grams) / 1000).toFixed(1) + 'kg'
          : undefined,
        image: str(imageObj?.src) || str(item.image_url),
      };
    });

    // ─── Fulfillments (tracking) ───
    const fulfillments = order.fulfillments as
      | Array<Record<string, unknown>>
      | undefined;
    const shippingLines = order.shipping_lines as
      | Array<Record<string, unknown>>
      | undefined;
    const trackingInfoFromFulfillments =
      fulfillments
        ?.flatMap((f) => {
          const directNumber = str(f.tracking_number);
          const directUrl = str(f.tracking_url);
          const directCarrier = str(f.tracking_company);
          const numbers = Array.isArray(f.tracking_numbers)
            ? (f.tracking_numbers as unknown[]).map((value) => str(value))
            : [];
          const urls = Array.isArray(f.tracking_urls)
            ? (f.tracking_urls as unknown[]).map((value) => str(value))
            : [];

          const rows: Array<{
            tracking_number?: string;
            tracking_url?: string;
            carrier?: string;
            status?: string;
            created_at?: string;
          }> = [];
          if (directNumber || directCarrier) {
            rows.push({
              tracking_number: directNumber,
              tracking_url: directUrl,
              carrier: directCarrier,
              status: str(f.status),
              created_at: fmtDate(f.created_at),
            });
          }
          numbers.forEach((number, idx) => {
            if (!number) return;
            rows.push({
              tracking_number: number,
              tracking_url: urls[idx],
              carrier: directCarrier,
              status: str(f.status),
              created_at: fmtDate(f.created_at),
            });
          });
          return rows;
        })
        .filter((row) => row.tracking_number || row.carrier) || [];
    const trackingInfoFromShippingLines =
      shippingLines
        ?.map((line) => ({
          tracking_number: str(line.code),
          tracking_url: str(line.url),
          carrier: str(line.title) || str(line.name),
          status: undefined,
          created_at: undefined,
        }))
        .filter((row) => row.tracking_number || row.carrier) || [];
    const trackingInfo = trackingInfoFromFulfillments.length
      ? trackingInfoFromFulfillments
      : trackingInfoFromShippingLines;

    // ─── Discounts ───
    const discountCodes = order.discount_codes as
      | Array<Record<string, unknown>>
      | undefined;
    const discounts =
      discountCodes?.map((d) => ({
        code: str(d.code) || '',
        amount: fmtPrice(d.amount),
        type: str(d.type),
      })) || [];

    // ─── Note attributes ───
    const noteAttrs = order.note_attributes as
      | Array<Record<string, unknown>>
      | undefined;
    const noteAttributes =
      noteAttrs?.map((a) => ({
        name: str(a.name) || '',
        value: str(a.value) || '',
      })) || [];

    return {
      // Order basics
      order_number:
        '#' +
        (str(order.order_number) || str(order.name) || '').replace(/^#+/, ''),
      status_text: status.text,
      status_class: status.class,
      financial_status: financialStatus,
      fulfillment_status:
        fulfillmentMap[fulfillmentStatus || 'notfulfilled'] ||
        fulfillmentStatus ||
        'Chưa giao hàng',
      fulfillment_status_raw: fulfillmentStatus || 'notfulfilled',

      // Dates
      created_at: fmtDate(order.created_at),
      updated_at: fmtDate(order.updated_at),
      closed_at: fmtDate(order.closed_at),
      cancelled_at: fmtDate(order.cancelled_at),

      // Prices
      subtotal_price: fmtPrice(order.subtotal_price),
      total_price: fmtPrice(order.total_price),
      total_discounts: fmtPrice(order.total_discounts),
      total_tax: fmtPrice(order.total_tax),
      total_shipping: fmtPrice(order.total_shipping_price),
      currency: str(order.currency),

      // Payment
      gateway: str(order.gateway),

      // Customer
      customer_name: customerName,
      phone:
        str(order.phone) ||
        str(customer?.phone) ||
        str(customerDefaultAddress?.phone) ||
        str(shipping?.phone) ||
        str(billing?.phone) ||
        '',
      email: str(order.email) || str(customer?.email) || '',

      // Addresses
      shipping_address:
        buildAddress(shipping) || buildAddress(customerDefaultAddress),
      billing_address: buildAddress(billing),

      // Products
      line_items: lineItems,
      item_count:
        rawItems?.reduce((sum, i) => sum + Number(i.quantity || 1), 0) || 0,

      // Shipping & tracking
      tracking: trackingInfo,

      // Extras
      note: str(order.note),
      tags: str(order.tags),
      discounts,
      note_attributes: noteAttributes,
      cancel_reason: str(order.cancel_reason),
      source_name: str(order.source_name),
    };
  }

  /**
   * Log lookup to Redis (lightweight audit trail).
   * Logs are stored as a list with auto-expiry (7 days).
   */
  private async logLookup(
    storeId: string,
    ip: string,
    phone: string | undefined,
    orderCode: string | undefined,
    resultCount: number,
    status: string,
  ): Promise<void> {
    try {
      const logKey = `${LOG_PREFIX}:${storeId}:global`;
      const phoneHash = this.hashAuditValue(phone);
      const orderCodeHash = this.hashAuditValue(orderCode);
      const ipHash = this.hashAuditValue(ip);
      const logs = (await this.redis.get<unknown[]>(logKey)) || [];
      const lookupLabel = orderCodeHash
        ? `order hash ${orderCodeHash}`
        : phoneHash
          ? `phone hash ${phoneHash}`
          : 'empty query';

      await this.redis.set(
        logKey,
        [
          {
            action: `lookup_${status}`,
            detail: `Public lookup ${lookupLabel}: ${resultCount} result(s)`,
            at: new Date().toISOString(),
            ip_hash: ipHash,
            phone_hash: phoneHash,
            order_code_hash: orderCodeHash,
            result_count: resultCount,
            status,
          },
          ...(Array.isArray(logs) ? logs : []),
        ].slice(0, 200),
        7 * 24 * 3600, // 7 days TTL
      );
      await this.db?.recordLookupEvent({
        orgid: storeId,
        ip,
        phone,
        orderCode,
        resultCount,
        status,
      });
    } catch {
      // Logging should never break the main flow
    }
  }

  private hashAuditValue(value: string | undefined): string | null {
    const raw = String(value || '')
      .trim()
      .toLowerCase();
    if (!raw) return null;
    const secret =
      String(this.config.get<string>('LOOKUP_HASH_SECRET') || '').trim() ||
      String(this.config.get<string>('APP_SESSION_SECRET') || '').trim() ||
      String(this.config.get<string>('HRV_CLIENT_SECRET') || '').trim();
    const digest = secret
      ? crypto.createHmac('sha256', secret).update(raw).digest('hex')
      : crypto.createHash('sha256').update(raw).digest('hex');
    return digest.slice(0, 16);
  }
}
