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
  widget_trigger_action: 'modal',
  widget_trigger_link_url: '',
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
  theme_text_color: '#ffffff',
  widget_texts: {},
  rebuy_enabled: true,
};

const createService = () => {
  const redisData = new Map<string, unknown>();
  const storeService = {
    getStoreByPublicShop: jest.fn().mockResolvedValue(baseStore),
    getSettings: jest.fn().mockResolvedValue(baseSettings),
    isEntitled: jest.fn().mockReturnValue(true),
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
      '10001',
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
      '10001',
      5,
    ]);
  });
});

describe('LookupService subscription gating', () => {
  it('refuses lookups for expired shops without calling Haravan', async () => {
    const { service, storeService, haravanOrderService } = createService();
    storeService.isEntitled.mockReturnValueOnce(false);

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

    expect(response).toMatchObject({
      success: false,
      error: 'subscription_expired',
    });
    expect(haravanOrderService.lookupOrders.mock.calls).toHaveLength(0);
  });
});

describe('LookupService captcha escalation', () => {
  const lookupOverHourlyLimit = async () => {
    const ctx = createService();
    ctx.rateLimitService.check.mockResolvedValueOnce({
      blocked: false,
      require_captcha: true,
    });
    const response = await ctx.service.lookup(
      'shop',
      '0901234567',
      '#10001',
      '203.0.113.10',
      'https://checkorders.example.com',
      'https://shop.myharavan.com',
      undefined,
      'checkorders.example.com',
    );
    return { ...ctx, response };
  };

  afterEach(() => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('does not lock shoppers out when Turnstile is not configured', async () => {
    const { response, haravanOrderService } = await lookupOverHourlyLimit();

    expect(response.success).toBe(true);
    expect(haravanOrderService.lookupOrders.mock.calls).toHaveLength(1);
  });

  it('demands a captcha token when Turnstile is configured', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site-key';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key';

    const { response, haravanOrderService } = await lookupOverHourlyLimit();

    expect(response).toMatchObject({
      success: false,
      error: 'captcha_required',
      require_captcha: true,
    });
    expect(haravanOrderService.lookupOrders.mock.calls).toHaveLength(0);
  });
});

describe('LookupService order normalization', () => {
  const lookupWith = async (
    order: Record<string, unknown>,
    visibleFields: StoreSettings['visible_fields'],
  ) => {
    const { service, storeService, haravanOrderService } = createService();
    haravanOrderService.lookupOrders.mockResolvedValueOnce([order]);
    storeService.getSettings.mockResolvedValueOnce({
      ...baseSettings,
      visible_fields: visibleFields,
    });
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
    return response.orders![0] as unknown as Record<string, unknown>;
  };

  it('renders dates in GMT+7 and keeps a zero total instead of dropping it', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        created_at: '2020-10-12T08:31:35.179Z',
        total_price: '0',
        total_discounts: '0',
      },
      ['order_number', 'created_at', 'total_price'],
    );

    expect(String(result.created_at)).toContain('15:31');
    expect(result.total_price).toBe('0₫');
    expect(result.total_discounts).toBeUndefined();
  });

  it('collapses a fulfillment that reports the same tracking number twice', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        fulfillments: [
          {
            status: 'success',
            tracking_company: 'Giao Hàng Nhanh',
            tracking_number: 'GHN123',
            tracking_numbers: ['GHN123'],
            tracking_urls: ['https://donhang.ghn.vn/?order_code=GHN123'],
          },
        ],
      },
      ['order_number', 'tracking_info'],
    );

    expect(result.tracking).toHaveLength(1);
  });

  it('keeps an unfulfilled order with only a shipping method as not shipped', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'pending',
        fulfillment_status: 'notfulfilled',
        fulfillments: [],
        shipping_lines: [
          { code: 'Giao hàng tận nơi', title: 'Giao hàng tận nơi', price: 0 },
        ],
      },
      ['order_number', 'fulfillment_status', 'tracking_info'],
    );

    expect(result.fulfillment_status_raw).toBe('notfulfilled');
    expect(result.fulfillment_status).toBe('Chưa giao hàng');
    expect(result.tracking).toEqual([
      expect.objectContaining({
        carrier: 'Giao hàng tận nơi',
        tracking_number: undefined,
      }),
    ]);
  });

  it.each([
    ['readytopick', 'Chờ lấy hàng', 'confirmed'],
    ['delivering', 'Đang giao hàng', 'shipping'],
    ['delivered', 'Đã giao hàng', 'fulfilled'],
    ['cancel', 'Hủy giao hàng', 'confirmed'],
    ['return', 'Đang hoàn hàng', 'shipping'],
  ])(
    'follows the carrier status %s instead of the order-level fulfilled flag',
    async (code, name, stage) => {
      const result = await lookupWith(
        {
          order_number: 10001,
          name: '#10001',
          financial_status: 'paid',
          fulfillment_status: 'fulfilled',
          fulfillments: [
            {
              status: 'success',
              created_at: '2020-10-07T08:39:24Z',
              tracking_company: 'Giao Hàng Nhanh',
              tracking_number: '000000',
              carrier_status_code: code,
              carrier_status_name: name,
            },
          ],
        },
        ['order_number', 'fulfillment_status'],
      );

      expect(result.fulfillment_status_raw).toBe(stage);
      expect(result.fulfillment_status).toBe(name);
    },
  );

  it('never shows a cancelled order as delivered even when its fulfillment succeeded', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        cancelled_at: '2020-10-08T08:39:24Z',
        fulfillments: [
          {
            status: 'success',
            created_at: '2020-10-07T08:39:24Z',
            tracking_company: 'Giao Hàng Nhanh',
            tracking_number: '000000',
            carrier_status_code: 'delivered',
            carrier_status_name: 'Đã giao hàng',
          },
        ],
      },
      ['order_number', 'fulfillment_status'],
    );

    expect(result.fulfillment_status_raw).toBe('cancelled');
    expect(result.fulfillment_status).toBe('Đã hủy giao hàng');
  });

  it('shows the buyer name the Haravan admin shows (billing name)', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        customer: { last_name: 'Q', first_name: 'Hang' },
        billing_address: { name: 'Tài Hàng', last_name: 'Tài', first_name: 'Hàng' },
        shipping_address: { name: 'Tài Hàng' },
      },
      ['order_number', 'customer_name'],
    );

    expect(result.customer_name).toBe('Tài Hàng');
  });

  it('shows the shipping fee from shipping lines so the totals add up like the admin', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        total_price: 850000,
        subtotal_price: 870000,
        total_discounts: 50000,
        total_shipping_price: null,
        shipping_lines: [{ title: 'Giao hàng tận nơi', price: 30000 }],
      },
      ['order_number', 'total_price'],
    );

    expect(result.total_shipping).toBe('30.000₫');
  });

  it('omits the shipping fee when the order ships for free', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        total_price: 200000,
        shipping_lines: [{ title: 'Miễn phí', price: 0 }],
      },
      ['order_number', 'total_price'],
    );

    expect(result.total_shipping).toBeUndefined();
  });

  it('flags orders the merchant confirmed even when payment is still pending', async () => {
    const confirmed = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'pending',
        confirmed_status: 'confirmed',
      },
      ['order_number', 'status'],
    );
    const unconfirmed = await lookupWith(
      {
        order_number: 10002,
        name: '#10002',
        financial_status: 'pending',
        confirmed_status: 'unconfirmed',
      },
      ['order_number', 'status'],
    );

    expect(confirmed.confirmed).toBe(true);
    expect(unconfirmed.confirmed).toBeUndefined();
  });

  it('keeps rebuy_items even when the merchant hides the product list', async () => {
    const result = await lookupWith(
      {
        order_number: 10001,
        name: '#10001',
        financial_status: 'paid',
        line_items: [
          { title: 'Áo', variant_id: 11, quantity: 2, price: '100000' },
          { title: 'Quà', quantity: 1, price: '0' },
        ],
      },
      ['order_number'],
    );

    expect(result.line_items).toBeUndefined();
    expect(result.rebuy_items).toEqual([
      { variant_id: 11, quantity: 2, title: 'Áo' },
    ]);
  });
});
