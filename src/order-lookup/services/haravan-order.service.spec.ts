import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
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
});

describe('HaravanOrderService DB order index integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('answers from DB and skips Haravan API and Redis when index is ready', async () => {
    const redis = new RedisMock();
    const orderIndexServiceMock = {
      isReady: jest.fn().mockResolvedValue(true),
      search: jest.fn().mockResolvedValue([
        { id: 999, name: '#ORD-999', phone: '0901234567' },
      ]),
      ensureBackfill: jest.fn().mockResolvedValue(undefined),
    };

    const service = new HaravanOrderService(
      config,
      redis as never,
      orderIndexServiceMock as never,
    );

    const results = await service.lookupOrders(
      'token',
      'store_ready',
      '0901234567',
      '#ORD-999',
      5,
    );

    expect(orderIndexServiceMock.isReady).toHaveBeenCalledWith('store_ready');
    expect(orderIndexServiceMock.search).toHaveBeenCalledWith(
      'store_ready',
      '0901234567',
      'ORD-999',
      5,
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(999);
    expect(mockedAxios.get).not.toHaveBeenCalled();
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
});
