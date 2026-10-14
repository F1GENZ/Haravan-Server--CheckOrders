import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { HaravanService } from '../../haravan/haravan.service';
import { OrderIndexService, extractOrderData } from './order-index.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

class RedisMock {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const val = this.store.get(key);
    return (val as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async setNx(key: string, value: unknown): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.store.set(key, value);
    return true;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

const makeConfig = (overrides: Record<string, string> = {}): ConfigService =>
  ({
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        DATA_ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        LOOKUP_HASH_SECRET: 'test-lookup-hash-secret',
        ...overrides,
      };
      return values[key];
    }),
  }) as unknown as ConfigService;

describe('OrderIndexService', () => {
  let config: ConfigService;
  let prismaService: PrismaService;
  let redisMock: RedisMock;
  let haravanServiceMock: Partial<HaravanService>;
  let orderIndexMock: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    findMany: jest.Mock;
  };
  let orderSyncStateMock: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  let transactionMock: jest.Mock;
  let service: OrderIndexService;

  beforeEach(() => {
    jest.clearAllMocks();
    config = makeConfig();
    prismaService = new PrismaService(config);

    orderIndexMock = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    };

    orderSyncStateMock = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    mockedAxios.isAxiosError.mockImplementation(
      (err: unknown): boolean =>
        Boolean(err && typeof err === 'object' && 'isAxiosError' in err),
    );

    transactionMock = jest.fn().mockImplementation(async (ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    const mockPrismaClient = {
      orderIndex: orderIndexMock,
      orderSyncState: orderSyncStateMock,
      $transaction: transactionMock,
    };

    Object.defineProperty(prismaService, 'prisma', {
      value: mockPrismaClient,
      writable: true,
    });

    redisMock = new RedisMock();
    haravanServiceMock = {
      resolveAccessToken: jest.fn().mockResolvedValue('test-access-token'),
      subscribeWebhooksForShop: jest.fn().mockResolvedValue(undefined),
    };

    service = new OrderIndexService(
      prismaService,
      redisMock as unknown as RedisService,
      haravanServiceMock as unknown as HaravanService,
      config,
    );
  });

  describe('phone-key determinism and equivalence', () => {
    it('produces identical phone keys for +84, 0, 84, and 0084 formats', () => {
      const p1 = '+84901234567';
      const p2 = '0901234567';
      const p3 = '84901234567';
      const p4 = '0084901234567';
      const p5 = '090 123 4567';
      const p6 = '090-123-4567';

      const key1 = prismaService.hashPhone(p1.replace(/\D/g, '').replace(/^84/, '0'));
      const hashFn = (val: string) => prismaService.hashPhone(val);

      const data1 = extractOrderData({ id: 1, phone: p1 }, hashFn);
      const data2 = extractOrderData({ id: 2, phone: p2 }, hashFn);
      const data3 = extractOrderData({ id: 3, phone: p3 }, hashFn);
      const data4 = extractOrderData({ id: 4, phone: p4 }, hashFn);
      const data5 = extractOrderData({ id: 5, phone: p5 }, hashFn);
      const data6 = extractOrderData({ id: 6, phone: p6 }, hashFn);

      expect(data1?.phoneKeys).toHaveLength(1);
      const expectedKey = data1!.phoneKeys[0];

      expect(data2?.phoneKeys[0]).toBe(expectedKey);
      expect(data3?.phoneKeys[0]).toBe(expectedKey);
      expect(data4?.phoneKeys[0]).toBe(expectedKey);
      expect(data5?.phoneKeys[0]).toBe(expectedKey);
      expect(data6?.phoneKeys[0]).toBe(expectedKey);
    });

    it('extracts phones from customer and address fields without duplicates', () => {
      const order = {
        id: 1001,
        phone: '0901234567',
        customer: {
          phone: '+84901234567', // duplicate of order.phone
          default_address: { phone: '0912345678' },
        },
        billing_address: { phone: '0923456789' },
        shipping_address: { phone: '0912345678' }, // duplicate of default_address
      };

      const data = extractOrderData(order, (p) => prismaService.hashPhone(p));
      expect(data).not.toBeNull();
      // Should have 3 unique phones: 0901234567, 0912345678, 0923456789
      expect(data?.phoneKeys).toHaveLength(3);
    });
  });

  describe('upsertOrder and deleteOrder', () => {
    it('encrypts payload and upserts OrderIndex with normalized fields', async () => {
      const order = {
        id: 5555,
        name: '#ORD-1001',
        order_number: 1001,
        phone: '0901234567',
        created_at: '2026-05-01T10:00:00Z',
      };

      await service.upsertOrder('store_1', order);

      expect(orderIndexMock.upsert).toHaveBeenCalledTimes(1);
      const upsertArgs = orderIndexMock.upsert.mock.calls[0][0];
      expect(upsertArgs.where).toEqual({
        orgid_haravanOrderId: {
          orgid: 'store_1',
          haravanOrderId: '5555',
        },
      });
      expect(upsertArgs.create.orderName).toBe('ord-1001');
      expect(upsertArgs.create.orderNumber).toBe('1001');
      expect(upsertArgs.create.payloadCiphertext).toBeDefined();
      expect(upsertArgs.create.payloadIv).toBeDefined();
      expect(upsertArgs.create.payloadTag).toBeDefined();
      expect(upsertArgs.create.phoneKeys).toHaveLength(1);
    });

    it('deletes order index by orgid and haravanOrderId', async () => {
      await service.deleteOrder('store_1', '5555');

      expect(orderIndexMock.deleteMany).toHaveBeenCalledWith({
        where: {
          orgid: 'store_1',
          haravanOrderId: '5555',
        },
      });
    });
  });

  describe('search AND semantics', () => {
    it('searches with phone only', async () => {
      orderIndexMock.findMany.mockResolvedValue([]);

      await service.search('store_1', '0901234567', undefined, 5);

      expect(orderIndexMock.findMany).toHaveBeenCalledTimes(1);
      const callArgs = orderIndexMock.findMany.mock.calls[0][0];
      expect(callArgs.where.orgid).toBe('store_1');
      expect(callArgs.where.phoneKeys).toEqual({
        has: prismaService.hashPhone('0901234567'),
      });
      expect(callArgs.where.OR).toBeUndefined();
    });

    it('searches with order code only', async () => {
      orderIndexMock.findMany.mockResolvedValue([]);

      await service.search('store_1', undefined, '#1001', 5);

      expect(orderIndexMock.findMany).toHaveBeenCalledTimes(1);
      const callArgs = orderIndexMock.findMany.mock.calls[0][0];
      expect(callArgs.where.orgid).toBe('store_1');
      expect(callArgs.where.phoneKeys).toBeUndefined();
      expect(callArgs.where.OR).toEqual([
        { orderNumber: '1001' },
        { orderName: '1001' },
      ]);
    });

    it('combines phone AND code when both given', async () => {
      orderIndexMock.findMany.mockResolvedValue([]);

      await service.search('store_1', '+84901234567', '#HD1001', 5);

      expect(orderIndexMock.findMany).toHaveBeenCalledTimes(1);
      const callArgs = orderIndexMock.findMany.mock.calls[0][0];
      expect(callArgs.where.orgid).toBe('store_1');
      expect(callArgs.where.phoneKeys).toEqual({
        has: prismaService.hashPhone('0901234567'),
      });
      expect(callArgs.where.OR).toEqual([
        { orderNumber: 'hd1001' },
        { orderName: 'hd1001' },
      ]);
    });

    it('decrypts found records and returns newest first', async () => {
      const rawOrder = { id: 111, name: '#111', phone: '0901234567' };
      const encrypted = prismaService.encrypt(JSON.stringify(rawOrder))!;

      orderIndexMock.findMany.mockResolvedValue([
        {
          haravanOrderId: '111',
          payloadCiphertext: encrypted.ciphertext,
          payloadIv: encrypted.iv,
          payloadTag: encrypted.tag,
        },
      ]);

      const results = await service.search('store_1', '0901234567');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(111);
      expect(results[0].name).toBe('#111');
    });

    it('returns empty array when neither phone nor code is provided', async () => {
      const results = await service.search('store_1', '', '');
      expect(results).toEqual([]);
      expect(orderIndexMock.findMany).not.toHaveBeenCalled();
    });
  });

  describe('isReady', () => {
    it('returns true when OrderSyncState status is ready', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue({ status: 'ready' });
      const ready = await service.isReady('store_1');
      expect(ready).toBe(true);
    });

    it('returns false when status is pending or not found', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue({ status: 'pending' });
      expect(await service.isReady('store_1')).toBe(false);

      orderSyncStateMock.findUnique.mockResolvedValue(null);
      expect(await service.isReady('store_1')).toBe(false);
    });
  });

  describe('backfill and ensureBackfill', () => {
    it('skips backfill if store is already ready', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue({ status: 'ready' });

      await service.ensureBackfill('store_1');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('backfills orders across pages and sets status to ready on last page', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue(null);

      // Page 1 returns 50 orders, Page 2 returns 2 orders (< 50 -> finish)
      const page1Orders = Array.from({ length: 50 }, (_, i) => ({
        id: 1000 + i,
        order_number: 1000 + i,
        name: `#ORD-${1000 + i}`,
        phone: '0901234567',
      }));
      const page2Orders = [
        { id: 2001, order_number: 2001, name: '#ORD-2001', phone: '0901234567' },
        { id: 2002, order_number: 2002, name: '#ORD-2002', phone: '0901234567' },
      ];

      mockedAxios.get
        .mockResolvedValueOnce({ data: { orders: page1Orders } })
        .mockResolvedValueOnce({ data: { orders: page2Orders } });

      await service.backfill('store_1', 'access-token-123');

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(orderSyncStateMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgid: 'store_1' },
          data: expect.objectContaining({
            status: 'ready',
            indexedCount: 52,
          }),
        }),
      );
    });

    it('handles 429 rate limiting during backfill by waiting and retrying', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue(null);

      const rateLimitError = {
        isAxiosError: true,
        response: {
          status: 429,
          headers: { 'retry-after': '0.01' },
        },
      };

      const finalOrders = [
        { id: 3001, order_number: 3001, name: '#ORD-3001', phone: '0901234567' },
      ];

      mockedAxios.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { orders: finalOrders } });

      await service.backfill('store_1', 'token');

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(orderSyncStateMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgid: 'store_1' },
          data: expect.objectContaining({ status: 'ready' }),
        }),
      );
    });

    it('purges order index and sync state on purgeOrg', async () => {
      await service.purgeOrg('store_1');

      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(orderIndexMock.deleteMany).toHaveBeenCalledWith({
        where: { orgid: 'store_1' },
      });
      expect(orderSyncStateMock.deleteMany).toHaveBeenCalledWith({
        where: { orgid: 'store_1' },
      });
    });

    it('requests status=any during backfill and resumes stale running state when Redis lock is gone', async () => {
      orderSyncStateMock.findUnique.mockResolvedValue({
        status: 'running',
        nextPage: 2,
        indexedCount: 50,
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          orders: [
            { id: 4001, order_number: 4001, name: '#4001', phone: '0901234567' },
          ],
        },
      });

      await service.ensureBackfill('store_resume');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://apis.haravan.com/com/orders.json?status=any&limit=50&page=2',
        expect.any(Object),
      );
      expect(orderSyncStateMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgid: 'store_resume' },
          data: expect.objectContaining({
            status: 'ready',
            backfillVersion: 2,
            finishedAt: expect.any(Date),
          }),
        }),
      );

      orderSyncStateMock.findUnique.mockResolvedValueOnce({
        status: 'ready',
        backfillVersion: 1,
      });
      expect(await service.isReady('store_legacy')).toBe(false);

      orderSyncStateMock.findUnique.mockResolvedValueOnce({
        status: 'ready',
        backfillVersion: 2,
      });
      expect(await service.isReady('store_v2')).toBe(true);
    });

    it('skips out-of-order stale webhook updates when existing haravanUpdatedAt is newer', async () => {
      orderIndexMock.findUnique.mockResolvedValueOnce({
        haravanUpdatedAt: new Date('2026-10-14T12:00:00Z'),
        cancelledAt: new Date('2026-10-14T12:00:00Z'),
      });

      await service.upsertOrder('store_1', {
        id: 5555,
        order_number: 5555,
        name: '#5555',
        phone: '0901234567',
        updated_at: '2026-10-14T10:00:00Z',
      });

      expect(orderIndexMock.upsert).not.toHaveBeenCalled();
    });
  });
});
