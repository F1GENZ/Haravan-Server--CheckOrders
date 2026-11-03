import type { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from './prisma.service';

const makeConfig = (overrides: Record<string, string> = {}): ConfigService =>
  ({
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        DATA_ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        LOOKUP_HASH_SECRET: 'hash-secret',
        ...overrides,
      };
      return values[key];
    }),
  }) as unknown as ConfigService;

describe('PrismaService token clearing on uninstall', () => {
  it('clears durable tokens for both Shop and AppInstall models in a transaction', async () => {
    const config = makeConfig();
    const service = new PrismaService(config);

    const mockShopUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const mockAppInstallUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const mockOrderIndexDeleteMany = jest.fn().mockResolvedValue({ count: 5 });
    const mockOrderSyncStateDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const mockTransaction = jest
      .fn()
      .mockImplementation(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      );

    (service as unknown as { prisma: unknown }).prisma = {
      $transaction: mockTransaction,
      shop: { updateMany: mockShopUpdateMany },
      appInstall: { updateMany: mockAppInstallUpdateMany },
      orderIndex: { deleteMany: mockOrderIndexDeleteMany },
      orderSyncState: { deleteMany: mockOrderSyncStateDeleteMany },
    };
    await service.clearTokensForUninstall('org_test_123');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockShopUpdateMany).toHaveBeenCalledWith({
      where: { orgid: 'org_test_123' },
      data: {
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenTag: null,
        isActive: false,
        status: 'uninstalled',
      },
    });
    expect(mockAppInstallUpdateMany).toHaveBeenCalledWith({
      where: { orgid: 'org_test_123' },
      data: {
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenTag: null,
        refreshTokenCiphertext: null,
        refreshTokenIv: null,
        refreshTokenTag: null,
        tokenExpiresAt: null,
        status: 'uninstalled',
      },
    });
    expect(mockOrderIndexDeleteMany).toHaveBeenCalledWith({
      where: { orgid: 'org_test_123' },
    });
    expect(mockOrderSyncStateDeleteMany).toHaveBeenCalledWith({
      where: { orgid: 'org_test_123' },
    });
  });

  it('re-throws when $transaction fails during uninstall token clearing', async () => {
    const config = makeConfig();
    const service = new PrismaService(config);

    (service as unknown as { prisma: unknown }).prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValue(new Error('Transaction aborted')),
      shop: { updateMany: jest.fn() },
      appInstall: { updateMany: jest.fn() },
      orderIndex: { deleteMany: jest.fn() },
      orderSyncState: { deleteMany: jest.fn() },
    };
    await expect(
      service.clearTokensForUninstall('org_test_fail'),
    ).rejects.toThrow('Transaction aborted');
  });
});

describe('PrismaService crypto and hashing helpers', () => {
  it('encrypts and decrypts values correctly', () => {
    const config = makeConfig();
    const service = new PrismaService(config);

    const payload = JSON.stringify({ id: 12345, name: '#HD1001' });
    const encrypted = service.encrypt(payload);
    expect(encrypted).not.toBeNull();
    expect(encrypted?.ciphertext).toBeDefined();
    expect(encrypted?.iv).toBeDefined();
    expect(encrypted?.tag).toBeDefined();

    const decrypted = service.decrypt(encrypted!);
    expect(decrypted).toBe(payload);
  });

  it('hashes normalized phones deterministically with keyed HMAC', () => {
    const config = makeConfig();
    const service = new PrismaService(config);

    const phone1 = '0901234567';
    const hash1 = service.hashPhone(phone1);
    const hash2 = service.hashPhone(phone1);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });
});

describe('PrismaService webhook audit', () => {
  const payload = { id: 7, phone: '0901234567', note: 'customer data' };

  const serviceWithClient = () => {
    const service = new PrismaService(makeConfig());
    const findUnique = jest.fn().mockResolvedValue({ id: 'shop-1' });
    const upsert = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { prisma: unknown }).prisma = {
      shop: { findUnique },
      webhookEvent: { upsert },
    };
    return { service, upsert };
  };

  it('stores the payload hash and headers but never the payload body', async () => {
    const { service, upsert } = serviceWithClient();

    await service.recordWebhook({
      topic: 'orders/create',
      orgid: 'org_1',
      payload,
      headers: { 'x-haravan-topic': 'orders/create' },
      status: 'processed',
    });

    const args = upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: { topic_orgid_payloadHash: { payloadHash: string } };
    };
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    expect('payload' in args.create).toBe(false);
    expect('payload' in args.update).toBe(false);
    expect(args.create.payloadHash).toBe(expectedHash);
    expect(args.where.topic_orgid_payloadHash.payloadHash).toBe(expectedHash);
    expect(args.create.headers).toEqual({ 'x-haravan-topic': 'orders/create' });
  });
});

describe('PrismaService production key handling', () => {
  const callHash = (service: PrismaService, value: string) =>
    (service as unknown as { hash(v: unknown): string | null }).hash(value);

  it('never falls back to other secrets or an unkeyed digest in production', () => {
    const service = new PrismaService(
      makeConfig({
        NODE_ENV: 'production',
        LOOKUP_HASH_SECRET: '',
        APP_SESSION_SECRET: 'session-secret',
        HRV_CLIENT_SECRET: 'client-secret',
      }),
    );
    expect(callHash(service, 'Order-1')).toBeNull();
  });

  it('uses only the lookup secret for audit hashes in production', () => {
    const service = new PrismaService(
      makeConfig({
        NODE_ENV: 'production',
        LOOKUP_HASH_SECRET: 'hash-secret',
        APP_SESSION_SECRET: 'session-secret',
      }),
    );
    expect(callHash(service, 'Order-1')).toBe(
      crypto.createHmac('sha256', 'hash-secret').update('order-1').digest('hex'),
    );
  });

  it('keeps the fallback chain outside production', () => {
    const service = new PrismaService(
      makeConfig({
        LOOKUP_HASH_SECRET: '',
        APP_SESSION_SECRET: 'session-secret',
      }),
    );
    expect(callHash(service, 'Order-1')).toBe(
      crypto
        .createHmac('sha256', 'session-secret')
        .update('order-1')
        .digest('hex'),
    );
  });

  it('refuses the constant phone-hash key in production when no secret is set', () => {
    const service = new PrismaService(
      makeConfig({
        NODE_ENV: 'production',
        LOOKUP_HASH_SECRET: '',
        DATA_ENCRYPTION_KEY: '',
        DATABASE_URL: '',
      }),
    );
    expect(() => service.resolveLookupHashKey()).toThrow(
      'LOOKUP_HASH_SECRET is required',
    );
  });

  it('still derives a development key without a secret', () => {
    const service = new PrismaService(
      makeConfig({
        LOOKUP_HASH_SECRET: '',
        DATA_ENCRYPTION_KEY: '',
        DATABASE_URL: '',
      }),
    );
    expect(service.resolveLookupHashKey()).toHaveLength(32);
  });
});
