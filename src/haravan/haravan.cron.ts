import {
  Injectable,
  Inject,
  Logger,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { setTimeout as sleep } from 'timers/promises';
import { RedisService } from '../redis/redis.service';
import { HaravanService } from './haravan.service';
import { PrismaService } from '../database/prisma.service';
import { OrderIndexService } from '../order-lookup/services/order-index.service';

type AppInstallData = {
  orgid?: string;
  refresh_token?: string;
  token_expires_at?: number;
  status?: string;
  plan?: string;
  expires_at?: number;
  subscription_status?: string;
  reinstall_reason?: string;
  reinstall_at?: number;
  haravan_token_status?: string;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
};

@Injectable()
export class HaravanCronService {
  private readonly logger = new Logger(HaravanCronService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly haravanService: HaravanService,
    @Optional()
    private readonly db?: PrismaService,
    @Inject(forwardRef(() => OrderIndexService))
    @Optional()
    private readonly orderIndexService?: OrderIndexService,
  ) {}

  @Cron(CronExpression.EVERY_12_HOURS)
  async handleCron() {
    this.logger.log('Running token refresh cron...');
    const appEntries = await this.fetchCandidateAppEntries();
    if (appEntries.length === 0) return;

    for (const { key, appData } of appEntries) {
      if (!appData?.refresh_token || !appData.orgid) continue;
      if (this.shouldSkip(appData)) continue;

      try {
        await this.haravanService.refreshToken(
          appData.orgid,
          appData.refresh_token,
        );
        this.logger.log(`Cron refreshed token for orgid: ${appData.orgid}`);
      } catch (error) {
        this.logger.warn(
          `Cron refresh failed for orgid: ${appData.orgid}: ${getErrorMessage(error)}`,
        );

        if (this.isAccessTokenExpired(appData) && !this.isProApp(appData)) {
          appData.status = 'needs_reinstall';
          appData.reinstall_reason =
            'Refresh token failed after access token expired';
          appData.reinstall_at = Date.now();
          await this.redisService.set(key, appData, 30 * 24 * 60 * 60);
        }
      }

      await sleep(500);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleOrderSyncCron() {
    if (!this.orderIndexService) return;
    this.logger.log('Running order sync & webhook maintenance cron...');
    const appEntries = await this.fetchCandidateAppEntries();

    for (const { appData } of appEntries) {
      if (!appData?.orgid || this.shouldSkipOrderSync(appData)) continue;
      const orgid = appData.orgid;

      // One-time webhook re-subscription for installed shops
      await this.ensureWebhooksResubscribed(orgid);

      // Sequential backfill: check if ready, if not ensureBackfill
      try {
        const isReady = await this.orderIndexService.isReady(orgid);
        if (!isReady) {
          this.logger.log(`Starting sequential backfill for orgid=${orgid}`);
          await this.orderIndexService.ensureBackfill(orgid);
        }
      } catch (err) {
        this.logger.warn(
          `Backfill failed for orgid=${orgid}: ${getErrorMessage(err)}`,
        );
      }

      await sleep(500);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleSubscriptionCron() {
    this.logger.log('Running subscription reconcile cron...');
    const appEntries = await this.fetchCandidateAppEntries();

    for (const { appData } of appEntries) {
      if (!appData?.orgid || this.requiresInstall(appData)) continue;
      try {
        await this.haravanService.reconcileSubscription(appData.orgid);
      } catch (error) {
        this.logger.warn(
          `Subscription reconcile failed for orgid=${appData.orgid}: ${getErrorMessage(error)}`,
        );
      }
      await sleep(500);
    }
  }

  private async ensureWebhooksResubscribed(orgid: string): Promise<void> {
    const key = `haravan:checkorders:webhooks_resubscribed_v2:${orgid}`;
    const alreadyDone = await this.redisService.has(key);
    if (alreadyDone) return;

    try {
      await this.haravanService.subscribeWebhooksForShop(orgid);
      await this.redisService.set(key, { at: new Date().toISOString() });
      this.logger.log(`One-time webhooks re-subscribed for orgid=${orgid}`);
    } catch (error) {
      this.logger.warn(
        `Failed to re-subscribe webhooks for orgid=${orgid}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async fetchCandidateAppEntries(): Promise<
    Array<{ key: string; appData: AppInstallData | null }>
  > {
    try {
      const keys = await this.redisService.scanKeys(
        'haravan:checkorders:app_install:*',
      );
      const appEntries = await Promise.all(
        keys.map(async (key) => ({
          key,
          appData: await this.redisService.get<AppInstallData>(key),
        })),
      );

      const redisOrgids = new Set(
        appEntries
          .map((entry) => entry.appData?.orgid)
          .filter((orgid): orgid is string => Boolean(orgid)),
      );
      const durableEntries = ((await this.db?.listInstallSessions()) ||
        []) as AppInstallData[];
      const missingDurableEntries = durableEntries.filter(
        (entry) => entry.orgid && !redisOrgids.has(entry.orgid),
      );
      appEntries.push(
        ...missingDurableEntries.map((appData) => ({
          key: `haravan:checkorders:app_install:${appData.orgid}`,
          appData,
        })),
      );
      return appEntries;
    } catch (err) {
      this.logger.error(`Cron failed to fetch keys: ${getErrorMessage(err)}`);
      return [];
    }
  }

  private shouldSkipOrderSync(appData: AppInstallData): boolean {
    if (this.requiresInstall(appData)) {
      return true;
    }

    if (
      String(appData.haravan_token_status || '').toLowerCase() ===
      'invalid_grant'
    ) {
      return true;
    }

    if (
      !this.isProApp(appData) &&
      appData.expires_at &&
      appData.expires_at <= Date.now()
    ) {
      return true;
    }

    return false;
  }

  private shouldSkip(appData: AppInstallData): boolean {
    if (this.shouldSkipOrderSync(appData)) {
      return true;
    }

    const tokenExpiresAt =
      typeof appData.token_expires_at === 'number'
        ? appData.token_expires_at
        : null;
    if (!tokenExpiresAt) return false;
    return (
      tokenExpiresAt - Date.now() >= 30 * 60 * 1000 &&
      !this.isAccessTokenExpirySuspicious(appData)
    );
  }

  private isAccessTokenExpired(appData: AppInstallData): boolean {
    return (
      typeof appData.token_expires_at === 'number' &&
      appData.token_expires_at <= Date.now()
    );
  }

  private isAccessTokenExpirySuspicious(appData: AppInstallData): boolean {
    const maxExpectedTtl = Number(
      process.env.HARAVAN_ACCESS_TOKEN_MAX_EXPECTED_TTL_MS,
    );
    if (!Number.isFinite(maxExpectedTtl) || maxExpectedTtl <= 0) return false;
    const threshold = Math.max(maxExpectedTtl, 3 * 365 * 24 * 60 * 60 * 1000);
    return (
      typeof appData.token_expires_at === 'number' &&
      appData.token_expires_at - Date.now() > threshold
    );
  }

  private isProApp(appData: AppInstallData): boolean {
    const status = String(appData.status || '').toLowerCase();
    if (
      [
        'unactive',
        'needs_reinstall',
        'uninstalled',
        'lapsed',
        'canceled',
        'cancelled',
        'expired',
        'declined',
      ].includes(status)
    ) {
      return false;
    }
    const hasValidExpiry =
      !appData.expires_at ||
      (typeof appData.expires_at === 'number' &&
        appData.expires_at > Date.now());
    if (!hasValidExpiry) return false;
    const plan = String(appData.plan || '').toLowerCase();
    const subscriptionStatus = String(
      appData.subscription_status || '',
    ).toLowerCase();
    return (
      plan === 'pro' ||
      subscriptionStatus === 'active' ||
      ['active', 'accepted', 'approved'].includes(status)
    );
  }

  private requiresInstall(appData: AppInstallData): boolean {
    if (this.isProApp(appData)) return false;
    const status = String(appData.status || '').toLowerCase();
    return [
      'unactive',
      'needs_reinstall',
      'uninstalled',
      'canceled',
      'expired',
      'declined',
    ].includes(status);
  }
}
