import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../database/prisma.service';
import type {
  LookupMethod,
  VisibleField,
  WidgetDisplayMode,
} from '../dto/store-settings.dto';

// ─── Types ───

export interface StoreRecord {
  org_id: string;
  shop_domain: string;
  custom_domain?: string;
  shop_domains?: string[];
  access_token: string;
  is_active: boolean;
  installed_at: string;
  expires_at?: string;
  status?: string;
  plan?: string;
}

export interface StoreSettings {
  widget_enabled: boolean;
  widget_display_mode: WidgetDisplayMode;
  lookup_method: LookupMethod;
  visible_fields: VisibleField[];
  max_orders: number;
  mask_phone: boolean;
  mask_email: boolean;
  mask_address: boolean;
  theme_color: string;
  widget_texts: Record<string, string>;
  rebuy_enabled: boolean;
}

const STORE_PREFIX = 'haravan:checkorder:store';
const SETTINGS_PREFIX = 'haravan:checkorder:settings';
const DOMAIN_INDEX_PREFIX = 'haravan:checkorder:domain';
const TRIAL_DAYS = 15;

const DEFAULT_WIDGET_TEXTS: Record<string, string> = {
  heading: 'Tra cứu đơn hàng',
  sub: 'Nhập thông tin để xem trạng thái đơn hàng của bạn',
  tab_phone: 'Số điện thoại',
  tab_code: 'Mã đơn hàng',
  label_phone: 'Số điện thoại',
  label_code: 'Mã đơn hàng',
  placeholder_phone: '0901 234 567',
  placeholder_code: '#10000',
  btn_search: 'Tra cứu',
  btn_loading: 'Đang tìm...',
  empty_title: 'Chưa có kết quả',
  empty_desc: 'Nhập thông tin bên trái để tra cứu đơn hàng',
  err_phone: 'Vui lòng nhập số điện thoại',
  err_code: 'Vui lòng nhập mã đơn hàng',
  err_not_found: 'Không tìm thấy đơn hàng phù hợp.',
  err_rate_limit: 'Bạn đã tra cứu quá nhiều lần, vui lòng thử lại sau.',
  err_auth: 'Hệ thống đang bảo trì, vui lòng quay lại sau.',
  err_server: 'Có lỗi xảy ra, vui lòng thử lại.',
  err_network: 'Không thể kết nối. Kiểm tra mạng và thử lại.',
  disabled_title: 'Tính năng tạm ngưng',
  disabled_desc: 'Tra cứu đơn hàng hiện không khả dụng.',
  btn_rebuy: 'Mua lại',
  popup_btn: 'Tra cứu đơn hàng',
};

const DEFAULT_SETTINGS: StoreSettings = {
  widget_enabled: true,
  widget_display_mode: 'inline',
  lookup_method: 'phone_and_code',
  visible_fields: [
    'order_number',
    'status',
    'created_at',
    'total_price',
    'fulfillment_status',
    'line_items',
  ],
  max_orders: 5,
  mask_phone: true,
  mask_email: true,
  mask_address: true,
  theme_color: '#4361ee',
  widget_texts: DEFAULT_WIDGET_TEXTS,
  rebuy_enabled: true,
};

const WIDGET_TEXT_KEYS = new Set([
  'heading',
  'sub',
  'tab_phone',
  'tab_code',
  'label_phone',
  'label_code',
  'placeholder_phone',
  'placeholder_code',
  'btn_search',
  'btn_loading',
  'empty_title',
  'empty_desc',
  'err_phone',
  'err_code',
  'err_not_found',
  'err_rate_limit',
  'err_auth',
  'err_server',
  'err_network',
  'disabled_title',
  'disabled_desc',
  'btn_rebuy',
  'popup_btn',
]);

/**
 * StoreService — Auth / Store Agent
 *
 * Manages store registrations, API keys, settings, and domain→store mapping.
 * All data is stored in Redis (no SQL database required for MVP).
 */
@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    private readonly redis: RedisService,
    @Optional()
    private readonly db?: PrismaService,
  ) {}

  // ─── Store CRUD ───

  /** Strip protocol, www, trailing slash → bare hostname */
  private normalizeDomain(raw: string): string {
    const value = String(raw || '').trim();
    if (!value) return '';

    try {
      const withProtocol = /^https?:\/\//i.test(value)
        ? value
        : `https://${value}`;
      return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return value
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '')
        .trim();
    }
  }

  private sanitizeWidgetTexts(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.entries(value as Record<string, unknown>).reduce(
      (acc, [key, raw]) => {
        if (!WIDGET_TEXT_KEYS.has(key) || typeof raw !== 'string') return acc;
        const text = raw.trim();
        if (text) acc[key] = text.slice(0, 180);
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  private toIsoDate(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const date =
      typeof value === 'number'
        ? new Date(value)
        : value instanceof Date
          ? value
          : typeof value === 'string'
            ? new Date(value)
            : null;
    if (!date) return undefined;
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }

  private defaultTrialExpiresAt(installedAt: string): string {
    const base = new Date(installedAt);
    const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
    safeBase.setDate(safeBase.getDate() + TRIAL_DAYS);
    return safeBase.toISOString();
  }

  private planFromStatus(status?: string): string {
    const normalized = String(status || 'trial').toLowerCase();
    if (['active', 'accepted', 'approved'].includes(normalized)) return 'Pro';
    if (normalized === 'trial') return 'Trial';
    return 'Free';
  }

  async registerStore(
    orgId: string,
    shopDomain: string,
    accessToken: string,
    customDomain?: string,
    extraDomains: string[] = [],
    lifecycle: {
      status?: string;
      plan?: string;
      installedAt?: string | number | Date;
      expiresAt?: string | number | Date;
    } = {},
  ): Promise<StoreRecord> {
    const existing = await this.getStoreByOrgId(orgId);

    const normalizedShop = this.normalizeDomain(shopDomain);
    const normalizedCustom = customDomain
      ? this.normalizeDomain(customDomain)
      : undefined;
    const shopDomains = [
      normalizedShop,
      normalizedCustom,
      ...extraDomains.map((domain) => this.normalizeDomain(domain)),
    ].filter((domain): domain is string => Boolean(domain));
    const uniqueShopDomains = [...new Set(shopDomains)];
    const oldDomains = new Set(
      [
        existing?.shop_domain,
        existing?.custom_domain,
        ...(existing?.shop_domains || []),
      ]
        .filter((domain): domain is string => Boolean(domain))
        .map((domain) => this.normalizeDomain(domain)),
    );
    const staleDomains = [...oldDomains].filter(
      (domain) => !uniqueShopDomains.includes(domain),
    );

    const installedAt =
      this.toIsoDate(lifecycle.installedAt) ||
      existing?.installed_at ||
      new Date().toISOString();
    const status = lifecycle.status || existing?.status || 'trial';
    const plan =
      lifecycle.plan || existing?.plan || this.planFromStatus(status);

    const store: StoreRecord = {
      org_id: orgId,
      shop_domain: normalizedShop,
      custom_domain: normalizedCustom,
      shop_domains: uniqueShopDomains,
      access_token: accessToken,
      is_active: true,
      installed_at: installedAt,
      expires_at:
        this.toIsoDate(lifecycle.expiresAt) ||
        existing?.expires_at ||
        this.defaultTrialExpiresAt(installedAt),
      status,
      plan,
    };

    // Store the main record
    await this.redis.set(`${STORE_PREFIX}:${orgId}`, store);
    await this.db?.upsertShop(store);

    await Promise.all(
      staleDomains.map(async (domain) => {
        const indexedOrgId = await this.redis.get<string>(
          `${DOMAIN_INDEX_PREFIX}:${domain}`,
        );
        if (indexedOrgId === orgId) {
          await this.redis.del(`${DOMAIN_INDEX_PREFIX}:${domain}`);
        }
      }),
    );

    // Index: domain → org_id (always bare hostname)
    await Promise.all(
      uniqueShopDomains.map((domain) =>
        this.redis.set(`${DOMAIN_INDEX_PREFIX}:${domain}`, orgId),
      ),
    );

    // Initialize default settings if new
    if (!existing) {
      await this.redis.set(`${SETTINGS_PREFIX}:${orgId}`, DEFAULT_SETTINGS);
      await this.db?.upsertSettings(orgId, DEFAULT_SETTINGS);
    }

    this.logger.log(`Store registered: ${orgId} (${normalizedShop})`);
    return store;
  }

  async getStoreByOrgId(orgId: string): Promise<StoreRecord | null> {
    const cached = await this.redis.get<StoreRecord>(
      `${STORE_PREFIX}:${orgId}`,
    );
    if (cached) return cached;

    const stored = await this.db?.findShopByOrgId(orgId);
    if (stored) {
      await this.redis.set(`${STORE_PREFIX}:${orgId}`, stored);
      await Promise.all(
        [
          stored.shop_domain,
          stored.custom_domain,
          ...(stored.shop_domains || []),
        ]
          .filter((domain): domain is string => Boolean(domain))
          .map((domain) =>
            this.redis.set(
              `${DOMAIN_INDEX_PREFIX}:${this.normalizeDomain(domain)}`,
              orgId,
            ),
          ),
      );
    }
    return stored || null;
  }

  async getStoreByDomain(domain: string): Promise<StoreRecord | null> {
    const normalized = this.normalizeDomain(domain);
    const orgId = await this.redis.get<string>(
      `${DOMAIN_INDEX_PREFIX}:${normalized}`,
    );
    if (orgId) return this.getStoreByOrgId(orgId);

    const stored = await this.db?.findShopByDomain(normalized);
    if (stored) {
      await this.redis.set(
        `${DOMAIN_INDEX_PREFIX}:${normalized}`,
        stored.org_id,
      );
      await this.redis.set(`${STORE_PREFIX}:${stored.org_id}`, stored);
    }
    return stored || null;
  }

  async getStoreByPublicShop(shop: string): Promise<StoreRecord | null> {
    let decoded = shop || '';
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    const normalized = this.normalizeDomain(decoded);
    if (!normalized) return null;

    const candidates = [
      normalized,
      normalized.includes('.') ? '' : `${normalized}.myharavan.com`,
    ].filter(Boolean);

    for (const candidate of [...new Set(candidates)]) {
      const store = await this.getStoreByDomain(candidate);
      if (store) return store;
    }
    return null;
  }

  async existsByDomain(domain: string): Promise<boolean> {
    const normalized = this.normalizeDomain(domain);
    return this.redis.has(`${DOMAIN_INDEX_PREFIX}:${normalized}`);
  }

  // ─── Settings ───

  async getSettings(orgId: string): Promise<StoreSettings> {
    const stored = await this.redis.get<StoreSettings>(
      `${SETTINGS_PREFIX}:${orgId}`,
    );
    const durableSettings = stored || (await this.db?.findSettings(orgId));
    if (!durableSettings) {
      return {
        ...DEFAULT_SETTINGS,
        widget_texts: { ...DEFAULT_WIDGET_TEXTS },
      };
    }

    // Merge defaults with stored (new default fields always filled in)
    const merged = {
      ...DEFAULT_SETTINGS,
      ...durableSettings,
      widget_texts: {
        ...DEFAULT_WIDGET_TEXTS,
        ...(durableSettings.widget_texts || {}),
      },
    };

    delete (merged as StoreSettings & { branded_links?: unknown })
      .branded_links;
    merged.widget_texts = this.sanitizeWidgetTexts(merged.widget_texts);
    merged.rebuy_enabled = merged.rebuy_enabled !== false;
    merged.widget_display_mode =
      merged.widget_display_mode === 'popup' ? 'popup' : 'inline';

    // One-time migration for existing stores
    let needsSave = false;

    // Add line_items to visible_fields if missing
    if (!merged.visible_fields.includes('line_items')) {
      merged.visible_fields.push('line_items');
      needsSave = true;
    }

    if (
      !durableSettings.widget_texts ||
      typeof durableSettings.widget_texts !== 'object'
    ) {
      needsSave = true;
    } else if (
      Object.keys(DEFAULT_WIDGET_TEXTS).some(
        (key) =>
          !Object.prototype.hasOwnProperty.call(
            durableSettings.widget_texts,
            key,
          ),
      )
    ) {
      needsSave = true;
    }
    if (typeof durableSettings.rebuy_enabled !== 'boolean') needsSave = true;
    if (
      !['inline', 'popup'].includes(String(durableSettings.widget_display_mode))
    ) {
      needsSave = true;
    }

    if (needsSave || !stored) {
      await this.redis.set(`${SETTINGS_PREFIX}:${orgId}`, merged);
      await this.db?.upsertSettings(orgId, merged);
    }

    return merged;
  }

  async updateSettings(
    orgId: string,
    partial: Partial<StoreSettings>,
  ): Promise<StoreSettings> {
    const current = await this.getSettings(orgId);
    const updated: StoreSettings = {
      ...current,
      ...partial,
      widget_texts:
        partial.widget_texts === undefined
          ? current.widget_texts
          : {
              ...DEFAULT_WIDGET_TEXTS,
              ...this.sanitizeWidgetTexts(partial.widget_texts),
            },
      rebuy_enabled: partial.rebuy_enabled ?? current.rebuy_enabled,
      widget_display_mode:
        partial.widget_display_mode === undefined
          ? current.widget_display_mode
          : partial.widget_display_mode === 'popup'
            ? 'popup'
            : 'inline',
    };
    delete (updated as StoreSettings & { branded_links?: unknown })
      .branded_links;
    await this.redis.set(`${SETTINGS_PREFIX}:${orgId}`, updated);
    await this.db?.upsertSettings(orgId, updated);
    return updated;
  }

  // ─── Domain Validation for CORS ───
}
