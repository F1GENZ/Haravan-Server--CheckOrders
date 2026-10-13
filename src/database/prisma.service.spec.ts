import type { ConfigService } from '@nestjs/config';
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
