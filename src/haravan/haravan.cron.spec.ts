import { HaravanCronService } from './haravan.cron';
import { RedisService } from '../redis/redis.service';
import { HaravanService } from './haravan.service';
import { PrismaService } from '../database/prisma.service';
import { OrderIndexService } from '../order-lookup/services/order-index.service';

class RedisMock {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const val = this.store.get(key);
    return (val as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

describe('HaravanCronService order sync & webhook resubscription', () => {
  let redisMock: RedisMock;
  let haravanServiceMock: {
    subscribeWebhooksForShop: jest.Mock;
    refreshToken: jest.Mock;
  };
  let dbMock: {
    listInstallSessions: jest.Mock;
  };
  let orderIndexServiceMock: {
    isReady: jest.Mock;
    ensureBackfill: jest.Mock;
  };
  let cronService: HaravanCronService;

  beforeEach(() => {
    jest.clearAllMocks();
    redisMock = new RedisMock();

    haravanServiceMock = {
      subscribeWebhooksForShop: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn().mockResolvedValue(undefined),
    };

    dbMock = {
      listInstallSessions: jest.fn().mockResolvedValue([]),
    };

    orderIndexServiceMock = {
      isReady: jest.fn().mockResolvedValue(false),
      ensureBackfill: jest.fn().mockResolvedValue(undefined),
    };

    cronService = new HaravanCronService(
      redisMock as unknown as RedisService,
      haravanServiceMock as unknown as HaravanService,
      dbMock as unknown as PrismaService,
      orderIndexServiceMock as unknown as OrderIndexService,
    );
  });

  it('runs sequential backfill and one-time webhook resubscribe for active stores', async () => {
    await redisMock.set('haravan:checkorders:app_install:org_shop_1', {
      orgid: 'org_shop_1',
      status: 'installed',
      refresh_token: 'refresh_tok_1',
      token_expires_at: Date.now() + 6 * 60 * 60 * 1000,
    });
    await redisMock.set('haravan:checkorders:app_install:org_shop_2', {
      orgid: 'org_shop_2',
      status: 'installed',
      refresh_token: 'refresh_tok_2',
      token_expires_at: Date.now() + 6 * 60 * 60 * 1000,
    });

    // org_shop_1 is not ready, org_shop_2 is already ready
    orderIndexServiceMock.isReady.mockImplementation(async (orgid: string) => {
      return orgid === 'org_shop_2';
    });

    await cronService.handleOrderSyncCron();

    // Both should have webhooks resubscribed once
    expect(haravanServiceMock.subscribeWebhooksForShop).toHaveBeenCalledWith('org_shop_1');
    expect(haravanServiceMock.subscribeWebhooksForShop).toHaveBeenCalledWith('org_shop_2');

    // Only org_shop_1 should be backfilled
    expect(orderIndexServiceMock.ensureBackfill).toHaveBeenCalledWith('org_shop_1');
    expect(orderIndexServiceMock.ensureBackfill).not.toHaveBeenCalledWith('org_shop_2');

    // Second cron run should NOT re-trigger webhooks subscription
    haravanServiceMock.subscribeWebhooksForShop.mockClear();
    await cronService.handleOrderSyncCron();
    expect(haravanServiceMock.subscribeWebhooksForShop).not.toHaveBeenCalled();
  });

  it('skips uninstalled or expired Pro shops in order sync cron', async () => {
    await redisMock.set('haravan:checkorders:app_install:org_uninstalled', {
      orgid: 'org_uninstalled',
      status: 'uninstalled',
      plan: 'Pro',
      subscription_status: 'active',
      refresh_token: 'refresh_tok_u',
    });
    await redisMock.set('haravan:checkorders:app_install:org_expired_pro', {
      orgid: 'org_expired_pro',
      status: 'active',
      plan: 'Pro',
      subscription_status: 'active',
      expires_at: Date.now() - 60_000,
      refresh_token: 'refresh_tok_e',
    });

    await cronService.handleOrderSyncCron();

    expect(haravanServiceMock.subscribeWebhooksForShop).not.toHaveBeenCalled();
    expect(orderIndexServiceMock.ensureBackfill).not.toHaveBeenCalled();
  });
});
