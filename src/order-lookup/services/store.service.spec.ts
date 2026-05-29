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
});
