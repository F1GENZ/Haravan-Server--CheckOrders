import { StoreService } from './store.service';

class RedisMock {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

describe('StoreService settings normalization', () => {
  it('does not force line_items back into visible_fields when merchant turned it off', async () => {
    const redis = new RedisMock();
    const db = {
      findSettings: jest.fn().mockResolvedValue({
        widget_enabled: true,
        widget_display_mode: 'inline',
        widget_trigger_action: 'modal',
        widget_trigger_link_url: '',
        lookup_method: 'phone_and_code',
        visible_fields: ['order_number', 'status', 'created_at'],
        visible_fields_version: 2,
        max_orders: 5,
        mask_phone: true,
        mask_email: true,
        mask_address: true,
        theme_color: '#4361ee',
        theme_text_color: '#ffffff',
        widget_texts: {},
        rebuy_enabled: true,
      }),
      upsertSettings: jest.fn(),
    };

    const service = new StoreService(redis as never, db as never);
    const result = await service.getSettings('org-1');

    expect(result.visible_fields).toEqual([
      'order_number',
      'status',
      'created_at',
    ]);
    expect(db.upsertSettings).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        visible_fields: ['order_number', 'status', 'created_at'],
      }),
    );
  });

  it('upgrades legacy visible_fields once: keeps customer name, derives tracking_info from fulfillment_status', async () => {
    const redis = new RedisMock();
    const baseSettings = {
      widget_enabled: true,
      widget_display_mode: 'inline',
      widget_trigger_action: 'modal',
      widget_trigger_link_url: '',
      lookup_method: 'phone_and_code',
      max_orders: 5,
      mask_phone: true,
      mask_email: true,
      mask_address: true,
      theme_color: '#4361ee',
      theme_text_color: '#ffffff',
      widget_texts: {},
      rebuy_enabled: true,
    };
    const withStatus = {
      findSettings: jest.fn().mockResolvedValue({
        ...baseSettings,
        visible_fields: ['order_number', 'fulfillment_status'],
      }),
      upsertSettings: jest.fn(),
    };
    const withoutStatus = {
      findSettings: jest.fn().mockResolvedValue({
        ...baseSettings,
        visible_fields: ['order_number'],
      }),
      upsertSettings: jest.fn(),
    };

    const a = await new StoreService(
      new RedisMock() as never,
      withStatus as never,
    ).getSettings('org-1');
    const b = await new StoreService(
      redis as never,
      withoutStatus as never,
    ).getSettings('org-2');

    expect(a.visible_fields).toEqual([
      'order_number',
      'fulfillment_status',
      'customer_name',
      'tracking_info',
    ]);
    expect(a.visible_fields_version).toBe(2);
    expect(withStatus.upsertSettings).toHaveBeenCalledTimes(1);
    expect(b.visible_fields).toEqual(['order_number', 'customer_name']);
  });
});

describe('StoreService.isEntitled', () => {
  const service = new StoreService(new RedisMock() as never);
  const now = Date.parse('2026-10-13T00:00:00Z');

  it('blocks expired trial and cancelled subscription statuses', () => {
    expect(
      service.isEntitled(
        { status: 'trial', plan: 'Trial', expires_at: '2026-06-04T00:00:00Z' },
        now,
      ),
    ).toBe(false);
    expect(
      service.isEntitled(
        { status: 'unactive', plan: 'Free', expires_at: '2027-01-01T00:00:00Z' },
        now,
      ),
    ).toBe(false);
  });

  it('allows live trial and paid plan', () => {
    expect(
      service.isEntitled(
        { status: 'trial', plan: 'Trial', expires_at: '2026-10-20T00:00:00Z' },
        now,
      ),
    ).toBe(true);
    expect(
      service.isEntitled(
        { status: 'active', plan: 'Pro', expires_at: '2026-01-01T00:00:00Z' },
        now,
      ),
    ).toBe(true);
  });

  it('rejects stores whose app was uninstalled even if expiry is in the future', () => {
    expect(
      service.isEntitled(
        { status: 'uninstalled', plan: 'Trial', expires_at: '2027-01-01T00:00:00Z' },
        now,
      ),
    ).toBe(false);
  });

  it('always entitles orgids listed in PREMIUM_ORGIDS, even when expired or uninstalled', () => {
    process.env.PREMIUM_ORGIDS = ' 111 , 1000405253 ';
    try {
      expect(
        service.isEntitled(
          {
            org_id: '1000405253',
            status: 'uninstalled',
            plan: 'Trial',
            expires_at: '2026-06-04T00:00:00Z',
          },
          now,
        ),
      ).toBe(true);
      expect(
        service.isEntitled(
          {
            org_id: '1000405254',
            status: 'trial',
            plan: 'Trial',
            expires_at: '2026-06-04T00:00:00Z',
          },
          now,
        ),
      ).toBe(false);
    } finally {
      delete process.env.PREMIUM_ORGIDS;
    }
  });

  it('returns Pro with a long expiry from store getters for PREMIUM_ORGIDS', async () => {
    process.env.PREMIUM_ORGIDS = 'org-p';
    try {
      const redis = new RedisMock();
      const svc = new StoreService(redis as never);
      const base = {
        shop_domain: 'p.myharavan.com',
        access_token: 'x',
        is_active: true,
        installed_at: '2026-05-28T00:00:00.000Z',
        status: 'trial',
        plan: 'Trial',
        expires_at: '2026-06-04T00:00:00.000Z',
      };
      await redis.set('haravan:checkorders:store:org-p', { ...base, org_id: 'org-p' });
      await redis.set('haravan:checkorders:store:org-n', { ...base, org_id: 'org-n' });
      await redis.set('haravan:checkorders:domain:p.myharavan.com', 'org-p');

      const premium = await svc.getStoreByOrgId('org-p');
      expect(premium?.plan).toBe('Pro');
      expect(premium?.status).toBe('active');
      expect(Date.parse(premium?.expires_at || '')).toBeGreaterThan(
        Date.now() + 5 * 365 * 24 * 60 * 60 * 1000,
      );
      expect((await svc.getStoreByPublicShop('p'))?.plan).toBe('Pro');

      const normal = await svc.getStoreByOrgId('org-n');
      expect(normal?.plan).toBe('Trial');
      expect(normal?.expires_at).toBe('2026-06-04T00:00:00.000Z');
    } finally {
      delete process.env.PREMIUM_ORGIDS;
    }
  });
});
