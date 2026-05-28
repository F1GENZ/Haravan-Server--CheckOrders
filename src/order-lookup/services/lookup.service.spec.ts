import { LookupService } from './lookup.service';
import { MaskingService } from './masking.service';
import type { StoreRecord, StoreSettings } from './store.service';
import type { StoreService } from './store.service';
import type { HaravanOrderService } from './haravan-order.service';
import type { RateLimitService } from './rate-limit.service';
import type { RedisService } from '../../redis/redis.service';
import type { HaravanService } from '../../haravan/haravan.service';
import type { ConfigService } from '@nestjs/config';

const baseStore: StoreRecord = {
  org_id: 'org-1',
  shop_domain: 'shop.myharavan.com',
  custom_domain: 'shop.example.com',
  shop_domains: ['shop.myharavan.com', 'shop.example.com'],
  access_token: 'stored-token',
  is_active: true,
  installed_at: '2026-01-01T00:00:00.000Z',
};

const baseSettings: StoreSettings = {
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
  widget_texts: {},
  rebuy_enabled: true,
};

const createService = () => {
  const redisData = new Map<string, unknown>();
  const storeService = {
    getStoreByPublicShop: jest.fn().mockResolvedValue(baseStore),
    getSettings: jest.fn().mockResolvedValue(baseSettings),
  };
  const haravanOrderService = {
    lookupOrders: jest.fn().mockResolvedValue([
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        created_at: '2026-01-01T00:00:00.000Z',
        total_price: '100000',
        line_items: [],
      },
    ]),
  };
  const rateLimitService = {
    check: jest.fn().mockResolvedValue({
      blocked: false,
      require_captcha: false,
    }),
  };
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(redisData.get(key) ?? null)),
    set: jest.fn((key: string, value: unknown) => {
      redisData.set(key, value);
      return Promise.resolve();
    }),
  };
  const haravanService = {
    resolveAccessToken: jest.fn().mockResolvedValue('fresh-token'),
  };
  const config = {
    get: jest.fn(() => 'lookup-secret'),
  };

  const service = new LookupService(
    storeService as unknown as StoreService,
    haravanOrderService as unknown as HaravanOrderService,
    new MaskingService(),
    rateLimitService as unknown as RateLimitService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    haravanService as unknown as HaravanService,
  );

  return {
    service,
    storeService,
    haravanOrderService,
    rateLimitService,
    haravanService,
  };
};

describe('LookupService storefront origin handling', () => {
  it('accepts same-origin proxy requests when x-store-origin matches the shop', async () => {
    const { service, haravanOrderService, haravanService } = createService();

    const response = await service.lookup(
      'shop',
      '0901234567',
      '#10001',
      '203.0.113.10',
      'https://checkorders.example.com',
      'https://shop.example.com',
      undefined,
      'checkorders.example.com',
    );

    expect(response.success).toBe(true);
    expect(haravanService.resolveAccessToken.mock.calls).toEqual([['org-1']]);
    expect(haravanOrderService.lookupOrders.mock.calls[0]).toEqual([
      'fresh-token',
      'org-1',
      '0901234567',
      '#10001',
      5,
    ]);
  });

  it('rejects same-origin proxy requests when x-store-origin is not a registered shop domain', async () => {
    const { service, haravanOrderService } = createService();

    const response = await service.lookup(
      'shop',
      '0901234567',
      '#10001',
      '203.0.113.10',
      'https://checkorders.example.com',
      'https://evil.example.net',
      undefined,
      'checkorders.example.com',
    );

    expect(response).toMatchObject({
      success: false,
      error: 'origin_mismatch',
    });
    expect(haravanOrderService.lookupOrders.mock.calls).toHaveLength(0);
  });

  it('accepts public shop lookups without storefront API key', async () => {
    const { service, storeService, haravanOrderService } = createService();

    const response = await service.lookup(
      'shop',
      '0901234567',
      '#10001',
      '203.0.113.10',
      'https://checkorders.example.com',
      'https://shop.myharavan.com',
      undefined,
      'checkorders.example.com',
    );

    expect(response.success).toBe(true);
    expect(storeService.getStoreByPublicShop.mock.calls).toEqual([['shop']]);
    expect(haravanOrderService.lookupOrders.mock.calls[0]).toEqual([
      'fresh-token',
      'org-1',
      '0901234567',
      '#10001',
      5,
    ]);
  });
});
