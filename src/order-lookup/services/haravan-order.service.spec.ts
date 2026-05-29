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
