import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { HaravanOrderService } from './haravan-order.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

class RedisMock {
  private readonly store = new Map<string, unknown>();

  get<T = unknown>(key: string): T | null {
    return (this.store.get(key) as T | undefined) || null;
  }
  set(key: string, value: unknown) {
    this.store.set(key, value);
  }

  setNx(key: string, value: unknown) {
    if (this.store.has(key)) return false;
    this.store.set(key, value);
    return true;
  }

  del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }

  incr(_key?: string, _ttlSeconds?: number): number {
    return 1;
  }
}

const config = {
  get: jest.fn((key: string) => {
    const values: Record<string, string> = {
      ORDER_LOOKUP_LOOKBACK_DAYS: '365',
      ORDER_LOOKUP_MAX_PAGES: '1',
    };
    return values[key];
  }),
} as unknown as ConfigService;

describe('HaravanOrderService lookup filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createService = () =>
    new HaravanOrderService(config, new RedisMock() as never);

  it('does not match order codes by partial substring', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          { id: 1, name: '#10001', order_number: 10001 },
          { id: 2, name: '#20001', order_number: 20001 },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      undefined,
      '1',
      5,
    );

    expect(result).toEqual([]);
  });

  it('matches order codes exactly', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          { id: 1, name: '#10001', order_number: 10001 },
          { id: 2, name: '#20001', order_number: 20001 },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      undefined,
      '10001',
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it('matches phone from customer fallback fields', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 1,
            name: '#10001',
            order_number: 10001,
            customer: { phone: '0906876467' },
          },
          {
            id: 2,
            name: '#10002',
            order_number: 10002,
            customer: { default_address: { phone: '0911111111' } },
          },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      '0906876467',
      undefined,
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it('matches +84 formatted phone numbers against normalized local input', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 1,
            name: '#10001',
            order_number: 10001,
            customer: { phone: '+84906876467' },
          },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      '0906876467',
      undefined,
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it('matches non-VN international phones after + strip', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 1,
            name: '#10001',
            order_number: 10001,
            customer: { phone: '+14155552671' },
          },
          {
            id: 2,
            name: '#10002',
            order_number: 10002,
            customer: { phone: '+84901234567' },
          },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      '+14155552671',
      undefined,
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it('matches long 15-digit phones exactly', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 1,
            name: '#10001',
            order_number: 10001,
            phone: '012345678901234',
          },
        ],
      },
    });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      '012345678901234',
      undefined,
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it('falls back to the deep window for phone-only lookups with orders older than the default lookback', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { orders: [] } })
      .mockResolvedValueOnce({
        data: {
          orders: [
            {
              id: 7,
              name: '#1000000370',
              order_number: 1000000370,
              phone: '0777620462',
            },
          ],
        },
      });

    const result = await createService().lookupOrders(
      'access-token',
      'store-1',
      '0777620462',
      undefined,
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(7);
    expect(mockedAxios.get.mock.calls).toHaveLength(2);
    const recentUrl = new URL(String(mockedAxios.get.mock.calls[0][0]));
    const deepUrl = new URL(String(mockedAxios.get.mock.calls[1][0]));
    const recentMin = new Date(
      recentUrl.searchParams.get('created_at_min') as string,
    ).getTime();
    const deepMin = new Date(
      deepUrl.searchParams.get('created_at_min') as string,
    ).getTime();
    expect(deepMin).toBeLessThan(recentMin - 365 * 24 * 3600 * 1000);
  });

  it('caches full filtered results before applying max order limit', async () => {
    const service = createService();
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          { id: 1, name: '#10001', order_number: 10001 },
          { id: 2, name: '#10002', order_number: 10002 },
        ],
      },
    });

    const first = await service.lookupOrders(
      'access-token',
      'store-1',
      undefined,
      '',
      1,
    );
    const second = await service.lookupOrders(
      'access-token',
      'store-1',
      undefined,
      '',
      2,
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(mockedAxios.get.mock.calls).toHaveLength(1);
  });

  it('does not poison negative cache when a concurrent deep fallback lock is held', async () => {
    const redis = new RedisMock();
    const service = new HaravanOrderService(config, redis as never);
    const cacheKey = (
      service as unknown as {
        buildCacheKey(store: string, phone: string, code: string): string;
      }
    ).buildCacheKey('store-locked', '0901234567', '10001');
    const lockKey = `haravan:checkorders:fallback_lock:${cacheKey}`;
    redis.set(lockKey, '1');

    mockedAxios.get.mockResolvedValueOnce({
      data: { orders: [] },
    });

    const first = await service.lookupOrders(
      'access-token',
      'store-locked',
      '0901234567',
      '#10001',
      5,
    );
    expect(first).toEqual([]);

    // Release fallback lock and provide matching order on retry; must NOT hit negative cache
    redis.del(lockKey);
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          { id: 77, name: '#10001', order_number: 10001, phone: '0901234567' },
        ],
      },
    });

    const second = await service.lookupOrders(
      'access-token',
      'store-locked',
      '0901234567',
      '#10001',
      5,
    );
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(77);
  });
});

describe('HaravanOrderService DB order index integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createIndexedService = (indexed: Array<Record<string, unknown>>) => {
    const orderIndexServiceMock = {
      isReady: jest.fn().mockResolvedValue(true),
      search: jest.fn().mockResolvedValue(indexed),
      upsertOrder: jest.fn().mockResolvedValue(undefined),
      deleteOrder: jest.fn().mockResolvedValue(undefined),
      ensureBackfill: jest.fn().mockResolvedValue(undefined),
    };
    const service = new HaravanOrderService(
      config,
      new RedisMock() as never,
      orderIndexServiceMock as never,
    );
    return { service, orderIndexServiceMock };
  };

  it('finds orders through the index but shows their current Haravan state', async () => {
    const { service, orderIndexServiceMock } = createIndexedService([
      { id: 999, name: '#ORD-999', fulfillment_status: 'notfulfilled' },
    ]);
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 999,
            name: '#ORD-999',
            fulfillment_status: 'fulfilled',
            cancelled_at: '2026-10-13T18:40:00Z',
          },
        ],
      },
    });

    const results = await service.lookupOrders(
      'token',
      'store_ready',
      '0901234567',
      '#ORD-999',
      5,
    );

    expect(orderIndexServiceMock.search).toHaveBeenCalledWith(
      'store_ready',
      '0901234567',
      'ORD-999',
      5,
    );
    const url = new URL(String(mockedAxios.get.mock.calls[0][0]));
    expect(url.searchParams.get('ids')).toBe('999');
    expect(url.searchParams.get('status')).toBe('any');
    expect(results).toHaveLength(1);
    expect(results[0].cancelled_at).toBe('2026-10-13T18:40:00Z');
    expect(orderIndexServiceMock.upsertOrder).toHaveBeenCalledWith(
      'store_ready',
      expect.objectContaining({ id: 999, fulfillment_status: 'fulfilled' }),
    );
  });

  it('returns more orders as soon as the merchant raises max_orders', async () => {
    const all = [1, 2, 3, 4].map((id) => ({ id, name: `#${id}` }));
    const { service, orderIndexServiceMock } = createIndexedService([]);
    orderIndexServiceMock.search.mockImplementation(
      (_store: string, _phone: string, _code: string, limit: number) =>
        Promise.resolve(all.slice(0, limit)),
    );
    const byIds = (url: string) => {
      const ids = (new URL(url).searchParams.get('ids') || '').split(',');
      return Promise.resolve({
        data: { orders: all.filter((o) => ids.includes(String(o.id))) },
      });
    };
    mockedAxios.get.mockImplementationOnce(byIds).mockImplementationOnce(byIds);

    const first = await service.lookupOrders('token', 'store_ready', '0901234567', '', 1);
    const second = await service.lookupOrders('token', 'store_ready', '0901234567', '', 3);

    expect(first).toHaveLength(1);
    expect(second.map((o) => o.id)).toEqual([1, 2, 3]);
  });

  it('hides indexed orders missing from the live refresh without deleting their index rows', async () => {
    const { service, orderIndexServiceMock } = createIndexedService([
      { id: 1, name: '#1' },
      { id: 2, name: '#2' },
    ]);
    mockedAxios.get.mockResolvedValueOnce({
      data: { orders: [{ id: 2, name: '#2' }] },
    });

    const results = await service.lookupOrders('token', 'store_ready', '0901234567');

    expect(results.map((order) => order.id)).toEqual([2]);
    expect(orderIndexServiceMock.deleteOrder).not.toHaveBeenCalled();
  });

  it('serves the indexed copy when Haravan is temporarily unreachable', async () => {
    const { service } = createIndexedService([{ id: 5, name: '#5' }]);
    mockedAxios.get.mockRejectedValueOnce(new Error('timeout'));

    const results = await service.lookupOrders('token', 'store_ready', '0901234567');

    expect(results.map((order) => order.id)).toEqual([5]);
  });

  it('reuses the cached refresh for repeated lookups', async () => {
    const { service, orderIndexServiceMock } = createIndexedService([
      { id: 7, name: '#7' },
    ]);
    mockedAxios.get.mockResolvedValueOnce({
      data: { orders: [{ id: 7, name: '#7' }] },
    });

    await service.lookupOrders('token', 'store_ready', '0901234567');
    const second = await service.lookupOrders('token', 'store_ready', '0901234567');

    expect(second.map((order) => order.id)).toEqual([7]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(orderIndexServiceMock.search).toHaveBeenCalledTimes(1);
  });

  it('falls back to Haravan API and fires ensureBackfill when index is not ready', async () => {
    const redis = new RedisMock();
    const orderIndexServiceMock = {
      isReady: jest.fn().mockResolvedValue(false),
      search: jest.fn(),
      ensureBackfill: jest.fn().mockResolvedValue(undefined),
    };

    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [{ id: 888, name: '#888', order_number: 888, phone: '0901234567' }],
      },
    });

    const service = new HaravanOrderService(
      config,
      redis as never,
      orderIndexServiceMock as never,
    );

    const results = await service.lookupOrders(
      'token',
      'store_not_ready',
      '0901234567',
      '#888',
      5,
    );

    expect(orderIndexServiceMock.isReady).toHaveBeenCalledWith('store_not_ready');
    expect(orderIndexServiceMock.ensureBackfill).toHaveBeenCalledWith('store_not_ready');
    expect(mockedAxios.get).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(888);
  });

  it('probes page 1 and indexes newly created orders when DB index returns empty', async () => {
    const { service, orderIndexServiceMock } = createIndexedService([]);
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        orders: [
          {
            id: 9001,
            order_number: 9001,
            name: '#9001',
            phone: '0901234567',
          },
        ],
      },
    });

    const results = await service.lookupOrders(
      'token',
      'store_ready',
      '0901234567',
      '#9001',
      5,
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(9001);
    expect(orderIndexServiceMock.upsertOrder).toHaveBeenCalledWith(
      'store_ready',
      expect.objectContaining({ id: 9001 }),
    );
  });
});

describe('HaravanOrderService sealed cache and fallback budget', () => {
  const DATA_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const makeConfig = (extra: Record<string, string> = {}): ConfigService =>
    ({
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          ORDER_LOOKUP_LOOKBACK_DAYS: '365',
          ORDER_LOOKUP_MAX_PAGES: '1',
          ...extra,
        };
        return values[key];
      }),
    }) as unknown as ConfigService;

  const keyedConfig = (extra: Record<string, string> = {}) =>
    makeConfig({
      DATA_ENCRYPTION_KEY: DATA_KEY,
      LOOKUP_HASH_SECRET: 'lookup-hash-secret',
      ...extra,
    });

  class CountingRedis extends RedisMock {
    readonly entries = new Map<string, unknown>();
    private readonly counters = new Map<string, number>();
    override get<T = unknown>(key: string): T | null {
      return (this.entries.get(key) as T | undefined) ?? super.get<T>(key);
    }
    override set(key: string, value: unknown) {
      this.entries.set(key, value);
    }
    incr(key: string): number {
      const next = (this.counters.get(key) || 0) + 1;
      this.counters.set(key, next);
      return next;
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  const order = {
    id: 11,
    name: '#10001',
    order_number: 10001,
    phone: '0901234567',
  };

  it('stores cached lookups sealed and reads them back', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(keyedConfig(), redis as never);
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [order] } });

    const first = await service.lookupOrders('t', 'store-1', '0901234567', '', 5);
    const second = await service.lookupOrders('t', 'store-1', '0901234567', '', 5);

    expect(first).toHaveLength(1);
    expect(second.map((o) => o.id)).toEqual([11]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    const cached = [...redis.entries.entries()].filter(([key]) =>
      key.startsWith('haravan:checkorders:cache:store-1:'),
    );
    expect(cached).toHaveLength(1);
    expect(typeof cached[0][1]).toBe('string');
    expect(String(cached[0][1]).startsWith('enc:v1:')).toBe(true);
    expect(String(cached[0][1])).not.toContain('0901234567');
    expect(String(cached[0][1])).not.toContain('#10001');
  });

  it('treats a sealed entry it cannot open as a cache miss', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(keyedConfig(), redis as never);
    const cacheKey = (
      service as unknown as {
        buildCacheKey(store: string, phone: string, code: string): string;
      }
    ).buildCacheKey('store-1', '0901234567', '');
    redis.set(cacheKey, 'enc:v1:AAAA.BBBB.CCCC');
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [order] } });

    const result = await service.lookupOrders('t', 'store-1', '0901234567', '', 5);

    expect(result.map((o) => o.id)).toEqual([11]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('still reads an unsealed legacy entry', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(keyedConfig(), redis as never);
    const cacheKey = (
      service as unknown as {
        buildCacheKey(store: string, phone: string, code: string): string;
      }
    ).buildCacheKey('store-1', '0901234567', '');
    redis.set(cacheKey, { orders: [order] });

    const result = await service.lookupOrders('t', 'store-1', '0901234567', '', 5);

    expect(result.map((o) => o.id)).toEqual([11]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('derives the cache key with a keyed HMAC under the store prefix', () => {
    const service = new HaravanOrderService(keyedConfig(), new CountingRedis() as never);
    const build = (
      service as unknown as {
        buildCacheKey(store: string, phone: string, code: string): string;
      }
    ).buildCacheKey.bind(service);
    const key = build('store-1', '0901234567', '10001');
    const unkeyed = crypto
      .createHash('sha256')
      .update('0901234567:10001')
      .digest('hex')
      .slice(0, 16);

    expect(key).toMatch(/^haravan:checkorders:cache:store-1:[a-f0-9]{16}$/);
    expect(key.endsWith(unkeyed)).toBe(false);
    expect(build('store-1', '0901234567', '10001')).toBe(key);
    const otherSecret = new HaravanOrderService(
      keyedConfig({ LOOKUP_HASH_SECRET: 'a-different-secret' }),
      new CountingRedis() as never,
    );
    expect(
      (
        otherSecret as unknown as {
          buildCacheKey(store: string, phone: string, code: string): string;
        }
      ).buildCacheKey('store-1', '0901234567', '10001'),
    ).not.toBe(key);
  });

  it('refuses to derive a cache key in production without a secret', () => {
    const service = new HaravanOrderService(
      makeConfig({ NODE_ENV: 'production' }),
      new CountingRedis() as never,
    );
    expect(() =>
      (
        service as unknown as {
          buildCacheKey(store: string, phone: string, code: string): string;
        }
      ).buildCacheKey('store-1', '0901234567', ''),
    ).toThrow('LOOKUP_HASH_SECRET is required');
  });

  it('stops running deep scans for a store over its per-minute budget and does not cache the skip', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(
      makeConfig({ ORDER_LOOKUP_FALLBACK_PER_MIN: '1' }),
      redis as never,
    );
    mockedAxios.get.mockResolvedValue({ data: { orders: [] } });

    await service.lookupOrders('t', 'store-1', '0901111111', '', 5);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);

    mockedAxios.get.mockClear();
    const capped = await service.lookupOrders('t', 'store-1', '0902222222', '', 5);

    expect(capped).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    const cacheKey = (
      service as unknown as {
        buildCacheKey(store: string, phone: string, code: string): string;
      }
    ).buildCacheKey('store-1', '0902222222', '');
    expect(redis.get(cacheKey)).toBeNull();
    expect(
      redis.get(`haravan:checkorders:fallback_lock:${cacheKey}`),
    ).toBeNull();
  });

  it('budgets each store separately', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(
      makeConfig({ ORDER_LOOKUP_FALLBACK_PER_MIN: '1' }),
      redis as never,
    );
    mockedAxios.get.mockResolvedValue({ data: { orders: [] } });

    await service.lookupOrders('t', 'store-1', '0901111111', '', 5);
    mockedAxios.get.mockClear();
    await service.lookupOrders('t', 'store-2', '0901111111', '', 5);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('refuses to write a plaintext cache entry in production without an encryption key', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(
      makeConfig({ NODE_ENV: 'production', LOOKUP_HASH_SECRET: 'lookup-secret' }),
      redis as never,
    );
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [order] } });

    await expect(
      service.lookupOrders('t', 'store-1', '0901234567', '', 5),
    ).rejects.toThrow('DATA_ENCRYPTION_KEY is required');
    expect(
      [...redis.entries.keys()].filter((key) => key.includes(':cache:')),
    ).toEqual([]);
  });

  it('seals normally in production when the key is configured', async () => {
    const redis = new CountingRedis();
    const service = new HaravanOrderService(
      keyedConfig({ NODE_ENV: 'production' }),
      redis as never,
    );
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [order] } });

    await service.lookupOrders('t', 'store-1', '0901234567', '', 5);

    const cached = [...redis.entries.entries()].find(([key]) =>
      key.includes(':cache:'),
    );
    expect(String(cached?.[1]).startsWith('enc:v1:')).toBe(true);
  });
});
