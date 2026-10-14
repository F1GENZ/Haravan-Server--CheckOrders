import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LookupRequestDto } from './dto/lookup-request.dto';
import * as fs from 'fs';
import * as path from 'path';
import type { Response } from 'express';
import { LookupController } from './controllers/lookup.controller';
import { MaskingService } from './services/masking.service';
import { normalizeLookupPhone, isValidLookupPhone } from './utils/phone.util';
import type { StoreRecord, StoreSettings } from './services/store.service';
import type { LookupService } from './services/lookup.service';
import type { StoreService } from './services/store.service';

describe('Order Lookup Contract Regression Suite', () => {
  describe('Phone normalization contract', () => {
    it('normalizes local Vietnamese phone numbers', () => {
      expect(normalizeLookupPhone('0901234567')).toBe('0901234567');
      expect(normalizeLookupPhone('090 123 4567')).toBe('0901234567');
      expect(normalizeLookupPhone('090-123-4567')).toBe('0901234567');
    });

    it('normalizes +84 and 84 prefix numbers to local format', () => {
      expect(normalizeLookupPhone('+84901234567')).toBe('0901234567');
      expect(normalizeLookupPhone('84901234567')).toBe('0901234567');
      expect(normalizeLookupPhone('+84 901 234 567')).toBe('0901234567');
      expect(normalizeLookupPhone('0084901234567')).toBe('0901234567');
    });

    it('preserves international digits and longer numbers up to 15 digits', () => {
      expect(normalizeLookupPhone('+14155552671')).toBe('14155552671');
      expect(normalizeLookupPhone('012345678901234')).toBe('012345678901234');
    });

    it('validates phone numbers correctly', () => {
      expect(isValidLookupPhone('0901234567')).toBe(true);
      expect(isValidLookupPhone(normalizeLookupPhone('+84901234567'))).toBe(true);
      expect(isValidLookupPhone(normalizeLookupPhone('+14155552671'))).toBe(true);
      expect(isValidLookupPhone('123')).toBe(false);
      expect(isValidLookupPhone('abcdefghij')).toBe(false);
    });
  });

  describe('MaskingService visibility & data privacy contract', () => {
    const maskingService = new MaskingService();

    const sampleOrder = {
      order_number: '#10001',
      status_text: 'Đã thanh toán',
      status_class: 'success' as const,
      financial_status: 'paid',
      fulfillment_status: 'Đã giao hàng',
      fulfillment_status_raw: 'fulfilled',
      created_at: '21/08/2026 10:00',
      total_price: '1.500.000₫',
      subtotal_price: '1.400.000₫',
      total_discounts: '50.000₫',
      gateway: 'COD',
      customer_name: 'Nguyen Van A',
      phone: '0901234567',
      email: 'customer@example.com',
      shipping_address: '123 Nguyen Hue, Quan 1, TP.HCM',
      line_items: [
        {
          id: 1,
          title: 'Ao Thun',
          variant_id: 101,
          variant_title: 'Size L',
          quantity: 2,
          price: '500.000₫',
        },
      ],
      tracking: [
        {
          carrier: 'GHTK',
          tracking_number: 'TRACK123',
          tracking_url: 'https://ghtk.vn/TRACK123',
        },
      ],
      cancelled_at: undefined,
    };

    it('masks phone, email, and address when enabled', () => {
      expect(maskingService.maskPhone('0901234567')).toBe('090***4567');
      expect(maskingService.maskEmail('customer@example.com')).toBe(
        'c***@example.com',
      );
      expect(maskingService.maskAddress('123 Nguyen Hue, Quan 1, TP.HCM')).toBe(
        '***TP.HCM',
      );
    });

    it('strips tracking and fulfillment details when fulfillment_status and tracking_info are not in visible_fields', () => {
      const filtered = maskingService.filterFields(sampleOrder, [
        'order_number',
        'status',
        'total_price',
      ]);

      expect(filtered.fulfillment_status).toBeUndefined();
      expect(filtered.fulfillment_status_raw).toBeUndefined();
      expect(filtered.tracking).toBeUndefined();
      expect(filtered.customer_name).toBeUndefined();
      expect(filtered.total_price).toBe('1.500.000₫');
      expect(filtered.subtotal_price).toBe('1.400.000₫');
      expect(filtered.gateway).toBe('COD');
    });

    it('keeps tracking independent from fulfillment_status', () => {
      const trackingOnly = maskingService.filterFields(sampleOrder, [
        'order_number',
        'tracking_info',
      ]);
      expect(trackingOnly.tracking).toHaveLength(1);
      expect(trackingOnly.fulfillment_status).toBeUndefined();

      const statusOnly = maskingService.filterFields(sampleOrder, [
        'order_number',
        'fulfillment_status',
      ]);
      expect(statusOnly.tracking).toBeUndefined();
      expect(statusOnly.fulfillment_status_raw).toBe('fulfilled');
    });

    it('keeps cancelled_at when only status is visible and drops it when neither status nor fulfillment_status is visible', () => {
      const cancelled = {
        ...sampleOrder,
        cancelled_at: '2026-10-13T18:40:39Z',
      };
      expect(
        maskingService.filterFields(cancelled, ['order_number', 'status'])
          .cancelled_at,
      ).toBe('2026-10-13T18:40:39Z');
      expect(
        maskingService.filterFields(cancelled, ['order_number'])
          .cancelled_at,
      ).toBeUndefined();
    });

    it('shows customer name only when customer_name is in visible_fields', () => {
      const withName = maskingService.filterFields(sampleOrder, [
        'order_number',
        'customer_name',
      ]);
      expect(withName.customer_name).toBe('Nguyen Van A');
    });

    it('strips financial breakdown when total_price is not in visible_fields', () => {
      const filtered = maskingService.filterFields(sampleOrder, [
        'order_number',
        'status',
        'fulfillment_status',
      ]);

      expect(filtered.total_price).toBeUndefined();
      expect(filtered.subtotal_price).toBeUndefined();
      expect(filtered.total_discounts).toBeUndefined();
      expect(filtered.gateway).toBeUndefined();
      expect(filtered.fulfillment_status).toBe('Đã giao hàng');
      expect(filtered.fulfillment_status_raw).toBe('fulfilled');
    });

    it('strips contact fields when phone, email, and shipping_address are not in visible_fields', () => {
      const filtered = maskingService.filterFields(sampleOrder, [
        'order_number',
        'status',
      ]);

      expect(filtered.phone).toBeUndefined();
      expect(filtered.email).toBeUndefined();
      expect(filtered.shipping_address).toBeUndefined();
    });
  });

  describe('LookupController serveEmbedScript generated code contracts', () => {
    const mockStore: StoreRecord = {
      org_id: 'org_test_1',
      shop_domain: 'hangquoctai.myharavan.com',
      custom_domain: 'hangquoctai.com',
      shop_domains: ['hangquoctai.myharavan.com', 'hangquoctai.com'],
      access_token: 'valid-token',
      is_active: true,
      installed_at: '2026-01-01T00:00:00.000Z',
    };

    const mockSettings: StoreSettings = {
      widget_enabled: true,
      widget_display_mode: 'trigger',
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
        'phone',
        'email',
        'shipping_address',
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

    const createController = () => {
      const mockLookupService = {} as unknown as LookupService;
      const mockStoreService = {
        getStoreByPublicShop: jest.fn().mockResolvedValue(mockStore),
        getSettings: jest.fn().mockResolvedValue(mockSettings),
        isEntitled: jest.fn().mockReturnValue(true),
      } as unknown as StoreService;

      const controller = new LookupController(
        mockLookupService,
        mockStoreService,
      );

      return { controller, mockStoreService };
    };

    it('generates embed script with mode override, shop-scoped frameId, origin guard, and rebuy bridge', async () => {
      const { controller } = createController();
      let sentJs = '';

      const mockRes = {
        setHeader: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        send: jest.fn((body: string) => {
          sentJs = body;
          return mockRes;
        }),
      } as unknown as Response;

      await controller.serveEmbedScript('hangquoctai', mockRes);

      expect(sentJs).toBeTruthy();

      // Mode -> launcher override
      expect(sentJs).toContain(
        'var embedMode = (scriptUrl.searchParams.get("mode") || "").trim().toLowerCase();',
      );
      expect(sentJs).toContain(
        'if (embedMode === "popup" || embedMode === "trigger" || embedMode === "inline") {',
      );
      expect(sentJs).toContain(
        'srcUrl.searchParams.set("launcher", embedMode);',
      );

      // Shop-scoped frame ID
      expect(sentJs).toContain('f1g-order-lookup-hangquoctai');

      // Origin guard
      expect(sentJs).toContain(
        'if (event.source !== frame.contentWindow || event.origin !== widgetOrigin) return;',
      );

      // Rebuy ACK / Done with requestId matching and empty validation
      expect(sentJs).toContain('if (data.type !== "f1g_rebuy_add_to_cart") return;');
      expect(sentJs).toContain('type: "f1g_rebuy_add_to_cart_ack"');
      expect(sentJs).toContain('requestId: requestId');
      expect(sentJs).toContain('type: "f1g_rebuy_add_to_cart_done"');
      expect(sentJs).toContain('message: "empty_items"');

      // Sequential cart addition via reduce
      expect(sentJs).toContain('items.reduce(function (promise, item) {');
      expect(sentJs).toContain('fetch("/cart/add.js"');
      expect(sentJs).toContain('window.location.href = "/cart";');
      expect(sentJs).toContain('srcUrl.searchParams.set("parent_origin", window.location.origin);');
      expect(sentJs).toContain('width:220px;height:64px');
      expect(sentJs).toContain('if (data.type === "f1g_widget_disabled")');
    });

    it('disables the embed for shops whose trial or subscription expired', async () => {
      const { controller, mockStoreService } = createController();
      (mockStoreService.isEntitled as jest.Mock).mockReturnValueOnce(false);
      let sentJs = '';
      const mockRes = {
        setHeader: jest.fn().mockReturnThis(),
        send: jest.fn((body: string) => {
          sentJs = body;
        }),
      } as unknown as Response;

      await controller.serveEmbedScript('hangquoctai', mockRes);

      expect(sentJs).toContain('var widgetEnabled = false;');
    });
  });
});

describe('LookupRequestDto order_code contract', () => {
  const check = (order_code: string) =>
    validateSync(
      plainToInstance(LookupRequestDto, {
        shop: 'shop.myharavan.com',
        phone: '0901234567',
        order_code,
      }),
    ).length;

  it('accepts merchant prefixes that use underscore or slash', () => {
    expect(check('#100012')).toBe(0);
    expect(check('DH_1001')).toBe(0);
    expect(check('DH/2026/05')).toBe(0);
    expect(check('#1')).toBe(0);
    expect(check('1')).toBe(0);
    expect(check('')).toBe(0);
  });

  it('rejects markup and quoting characters', () => {
    expect(check('<img src=x>')).toBeGreaterThan(0);
    expect(check("1' OR '1'='1")).toBeGreaterThan(0);
    expect(check('＃100012')).toBeGreaterThan(0);
  });
});
