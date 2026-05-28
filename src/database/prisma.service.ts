import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import type {
  StoreRecord,
  StoreSettings,
} from '../order-lookup/services/store.service';

type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
};

type LookupAuditInput = {
  orgid: string;
  ip?: string;
  phone?: string;
  orderCode?: string;
  status: string;
  resultCount: number;
  durationMs?: number;
  cacheStatus?: string;
  originHost?: string;
};

type SubscriptionAuditInput = {
  orgid: string;
  status: string;
  plan: string;
  isActive: boolean;
  expiresAt?: number;
  syncedAt: number;
  payload?: Record<string, unknown>;
};

type WebhookAuditInput = {
  topic: string;
  orgid?: string | null;
  payload?: unknown;
  headers?: Record<string, unknown>;
  status: string;
  error?: string;
};

type SubscriptionSnapshotRecord = {
  orgid: string;
  status: string;
  plan: string;
  is_active: boolean;
  expires_at?: number;
  synced_at: number;
  subscription_payload?: Record<string, unknown>;
};

const stringValue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
};

const toDate = (value?: string | number | Date): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const date =
    typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeDomain = (value: unknown): string => {
  const raw = stringValue(value);
  if (!raw) return '';
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .trim();
  }
};

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly prisma: PrismaClient | null;
  private readonly encryptionKey: Buffer | null;
  readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const databaseUrl = String(
      this.config.get<string>('DATABASE_URL') || '',
    ).trim();
    this.enabled = Boolean(databaseUrl);
    this.prisma = this.enabled
      ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
      : null;
    this.encryptionKey = this.resolveEncryptionKey();
    if (this.enabled && !this.encryptionKey) {
      throw new Error(
        'DATA_ENCRYPTION_KEY is required when DATABASE_URL is set',
      );
    }
  }

  async onModuleInit() {
    if (!this.prisma) return;
    try {
      await this.prisma.$connect();
      this.logger.log('Prisma database connected');
    } catch (error) {
      this.logger.error(
        `Prisma database connection failed: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.prisma?.$disconnect();
  }

  async ping(): Promise<'ok' | 'disabled' | 'error'> {
    if (!this.prisma) return 'disabled';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private resolveEncryptionKey(): Buffer | null {
    const raw = String(
      this.config.get<string>('DATA_ENCRYPTION_KEY') || '',
    ).trim();
    if (!raw) return null;
    try {
      if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) return decoded;
    } catch {
      // Fall through to hash-based normalization.
    }
    return crypto.createHash('sha256').update(raw).digest();
  }

  private encrypt(value: string): EncryptedValue | null {
    if (!this.encryptionKey || !value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(input: {
    accessTokenCiphertext?: string | null;
    accessTokenIv?: string | null;
    accessTokenTag?: string | null;
  }): string {
    return this.decryptParts(
      input.accessTokenCiphertext,
      input.accessTokenIv,
      input.accessTokenTag,
    );
  }

  private decryptParts(
    ciphertext?: string | null,
    iv?: string | null,
    tag?: string | null,
  ): string {
    if (!this.encryptionKey || !ciphertext || !iv || !tag) {
      return '';
    }
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to decrypt access token: ${this.getErrorMessage(error)}`,
      );
      return '';
    }
  }

  private hash(value: unknown): string | null {
    const raw = stringValue(value).toLowerCase();
    if (!raw) return null;
    const secret =
      String(this.config.get<string>('LOOKUP_HASH_SECRET') || '').trim() ||
      String(this.config.get<string>('APP_SESSION_SECRET') || '').trim() ||
      String(this.config.get<string>('HRV_CLIENT_SECRET') || '').trim();
    const hmac = secret
      ? crypto.createHmac('sha256', secret).update(raw).digest('hex')
      : crypto.createHash('sha256').update(raw).digest('hex');
    return hmac;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private toOptionalJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private shopToStoreRecord(shop: {
    orgid: string;
    shopDomain: string;
    customDomain?: string | null;
    isActive: boolean;
    installedAt: Date;
    expiresAt?: Date | null;
    status?: string | null;
    plan?: string | null;
    domains?: Array<{ domain: string }>;
    accessTokenCiphertext?: string | null;
    accessTokenIv?: string | null;
    accessTokenTag?: string | null;
  }): StoreRecord {
    return {
      org_id: shop.orgid,
      shop_domain: shop.shopDomain,
      custom_domain: shop.customDomain || undefined,
      shop_domains: [
        shop.shopDomain,
        shop.customDomain || '',
        ...(shop.domains || []).map((domain) => domain.domain),
      ].filter(Boolean),
      access_token: this.decrypt(shop),
      is_active: shop.isActive,
      installed_at: shop.installedAt.toISOString(),
      expires_at: shop.expiresAt?.toISOString(),
      status: shop.status || 'trial',
      plan: shop.plan || 'Trial',
    };
  }

  async upsertShop(store: StoreRecord): Promise<void> {
    if (!this.prisma) return;
    try {
      const encrypted = this.encrypt(store.access_token);
      const installedAt = toDate(store.installed_at) || new Date();
      const expiresAt = toDate(store.expires_at);
      const domains = [
        store.shop_domain,
        store.custom_domain,
        ...(store.shop_domains || []),
      ]
        .map(normalizeDomain)
        .filter(Boolean);
      const uniqueDomains = [...new Set(domains)];

      const shop = await this.prisma.shop.upsert({
        where: { orgid: store.org_id },
        create: {
          orgid: store.org_id,
          shopDomain: normalizeDomain(store.shop_domain),
          customDomain: store.custom_domain
            ? normalizeDomain(store.custom_domain)
            : null,
          accessTokenCiphertext: encrypted?.ciphertext,
          accessTokenIv: encrypted?.iv,
          accessTokenTag: encrypted?.tag,
          isActive: store.is_active,
          installedAt,
          expiresAt,
          status: store.status || 'trial',
          plan: store.plan || 'Trial',
        },
        update: {
          shopDomain: normalizeDomain(store.shop_domain),
          customDomain: store.custom_domain
            ? normalizeDomain(store.custom_domain)
            : null,
          ...(encrypted
            ? {
                accessTokenCiphertext: encrypted.ciphertext,
                accessTokenIv: encrypted.iv,
                accessTokenTag: encrypted.tag,
              }
            : {}),
          isActive: store.is_active,
          installedAt,
          expiresAt,
          status: store.status || 'trial',
          plan: store.plan || 'Trial',
        },
      });

      await this.prisma.shopDomain.deleteMany({
        where: {
          shopId: shop.id,
          domain: { notIn: uniqueDomains.length ? uniqueDomains : [''] },
        },
      });
      await Promise.all(
        uniqueDomains.map((domain, index) =>
          this.prisma!.shopDomain.upsert({
            where: { domain },
            create: {
              shopId: shop.id,
              domain,
              kind: index === 0 ? 'primary' : 'alias',
            },
            update: {
              shopId: shop.id,
              kind: index === 0 ? 'primary' : 'alias',
            },
          }),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `DB shop upsert skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async upsertInstallSession(
    orgid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma) return;
    try {
      const access = this.encrypt(stringValue(data.access_token));
      const refresh = this.encrypt(stringValue(data.refresh_token));
      const tokenExpiresAt = toDate(data.token_expires_at as string | number);
      const expiresAt = toDate(data.expires_at as string | number);
      const installedAt = toDate(data.installed_at as string | number);
      const subscriptionUpdatedAt = toDate(
        data.subscription_updated_at as string | number,
      );
      const metadata = { ...data };
      delete metadata.access_token;
      delete metadata.refresh_token;

      await this.prisma.appInstall.upsert({
        where: { orgid },
        create: {
          orgid,
          orgsub: stringValue(data.orgsub) || null,
          domain: stringValue(data.domain) || null,
          primaryDomain: stringValue(data.primary_domain) || null,
          myharavanDomain: stringValue(data.myharavan_domain) || null,
          accessTokenCiphertext: access?.ciphertext,
          accessTokenIv: access?.iv,
          accessTokenTag: access?.tag,
          refreshTokenCiphertext: refresh?.ciphertext,
          refreshTokenIv: refresh?.iv,
          refreshTokenTag: refresh?.tag,
          tokenExpiresAt,
          status: stringValue(data.status) || 'trial',
          plan: stringValue(data.plan) || null,
          expiresAt,
          installedAt,
          quotaTotal:
            typeof data.quota_total === 'number' ? data.quota_total : null,
          quotaRemaining:
            typeof data.quota_remaining === 'number'
              ? data.quota_remaining
              : null,
          subscriptionStatus: stringValue(data.subscription_status) || null,
          subscriptionUpdatedAt,
          metadata: this.toOptionalJson(metadata),
        },
        update: {
          orgsub: stringValue(data.orgsub) || null,
          domain: stringValue(data.domain) || null,
          primaryDomain: stringValue(data.primary_domain) || null,
          myharavanDomain: stringValue(data.myharavan_domain) || null,
          ...(access
            ? {
                accessTokenCiphertext: access.ciphertext,
                accessTokenIv: access.iv,
                accessTokenTag: access.tag,
              }
            : {}),
          ...(refresh
            ? {
                refreshTokenCiphertext: refresh.ciphertext,
                refreshTokenIv: refresh.iv,
                refreshTokenTag: refresh.tag,
              }
            : {}),
          tokenExpiresAt,
          status: stringValue(data.status) || 'trial',
          plan: stringValue(data.plan) || null,
          expiresAt,
          installedAt,
          quotaTotal:
            typeof data.quota_total === 'number' ? data.quota_total : null,
          quotaRemaining:
            typeof data.quota_remaining === 'number'
              ? data.quota_remaining
              : null,
          subscriptionStatus: stringValue(data.subscription_status) || null,
          subscriptionUpdatedAt,
          metadata: this.toOptionalJson(metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB install session upsert skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async findInstallSession(
    orgid: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.prisma) return null;
    try {
      const row = await this.prisma.appInstall.findUnique({ where: { orgid } });
      if (!row) return null;
      return {
        orgid: row.orgid,
        orgsub: row.orgsub || undefined,
        domain: row.domain || undefined,
        primary_domain: row.primaryDomain || undefined,
        myharavan_domain: row.myharavanDomain || undefined,
        access_token: this.decryptParts(
          row.accessTokenCiphertext,
          row.accessTokenIv,
          row.accessTokenTag,
        ),
        refresh_token: this.decryptParts(
          row.refreshTokenCiphertext,
          row.refreshTokenIv,
          row.refreshTokenTag,
        ),
        token_expires_at: row.tokenExpiresAt?.getTime(),
        status: row.status,
        plan: row.plan || undefined,
        expires_at: row.expiresAt?.getTime(),
        installed_at: row.installedAt?.getTime(),
        quota_total: row.quotaTotal ?? undefined,
        quota_remaining: row.quotaRemaining ?? undefined,
        subscription_status: row.subscriptionStatus || undefined,
        subscription_updated_at: row.subscriptionUpdatedAt?.getTime(),
      };
    } catch (error) {
      this.logger.warn(
        `DB install session read skipped: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  async listInstallSessions(limit = 1000): Promise<Record<string, unknown>[]> {
    if (!this.prisma) return [];
    try {
      const rows = await this.prisma.appInstall.findMany({
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      return rows.map((row) => ({
        orgid: row.orgid,
        orgsub: row.orgsub || undefined,
        domain: row.domain || undefined,
        primary_domain: row.primaryDomain || undefined,
        myharavan_domain: row.myharavanDomain || undefined,
        access_token: this.decryptParts(
          row.accessTokenCiphertext,
          row.accessTokenIv,
          row.accessTokenTag,
        ),
        refresh_token: this.decryptParts(
          row.refreshTokenCiphertext,
          row.refreshTokenIv,
          row.refreshTokenTag,
        ),
        token_expires_at: row.tokenExpiresAt?.getTime(),
        status: row.status,
        plan: row.plan || undefined,
        expires_at: row.expiresAt?.getTime(),
        installed_at: row.installedAt?.getTime(),
        quota_total: row.quotaTotal ?? undefined,
        quota_remaining: row.quotaRemaining ?? undefined,
        subscription_status: row.subscriptionStatus || undefined,
        subscription_updated_at: row.subscriptionUpdatedAt?.getTime(),
      }));
    } catch (error) {
      this.logger.warn(
        `DB install session list skipped: ${this.getErrorMessage(error)}`,
      );
      return [];
    }
  }

  async findShopByOrgId(orgid: string): Promise<StoreRecord | null> {
    if (!this.prisma) return null;
    try {
      const shop = await this.prisma.shop.findUnique({
        where: { orgid },
        include: { domains: true },
      });
      return shop ? this.shopToStoreRecord(shop) : null;
    } catch (error) {
      this.logger.warn(`DB shop read skipped: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  async findShopByDomain(domain: string): Promise<StoreRecord | null> {
    if (!this.prisma) return null;
    try {
      const normalized = normalizeDomain(domain);
      const indexed = await this.prisma.shopDomain.findUnique({
        where: { domain: normalized },
        include: { shop: { include: { domains: true } } },
      });
      if (indexed?.shop) return this.shopToStoreRecord(indexed.shop);

      const shop = await this.prisma.shop.findFirst({
        where: {
          OR: [{ shopDomain: normalized }, { customDomain: normalized }],
        },
        include: { domains: true },
      });
      return shop ? this.shopToStoreRecord(shop) : null;
    } catch (error) {
      this.logger.warn(
        `DB domain read skipped: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  async upsertSettings(orgid: string, settings: StoreSettings): Promise<void> {
    if (!this.prisma) return;
    try {
      const shop = await this.prisma.shop.findUnique({ where: { orgid } });
      if (!shop) return;
      await this.prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        create: {
          shopId: shop.id,
          orgid,
          settings: this.toJson(settings),
        },
        update: {
          settings: this.toJson(settings),
          version: { increment: 1 },
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB settings upsert skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async findSettings(orgid: string): Promise<StoreSettings | null> {
    if (!this.prisma) return null;
    try {
      const record = await this.prisma.shopSettings.findUnique({
        where: { orgid },
      });
      return record?.settings as StoreSettings | null;
    } catch (error) {
      this.logger.warn(
        `DB settings read skipped: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  async markShopInactive(orgid: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.shop.update({
        where: { orgid },
        data: {
          isActive: false,
          status: 'uninstalled',
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB shop deactivate skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async recordLookupEvent(input: LookupAuditInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const shop = await this.prisma.shop.findUnique({
        where: { orgid: input.orgid },
        select: { id: true },
      });
      await this.prisma.lookupEvent.create({
        data: {
          shopId: shop?.id,
          orgid: input.orgid,
          ipHash: this.hash(input.ip),
          phoneHash: this.hash(input.phone),
          orderCodeHash: this.hash(input.orderCode),
          status: input.status,
          resultCount: input.resultCount,
          durationMs: input.durationMs,
          cacheStatus: input.cacheStatus,
          originHost: input.originHost,
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB lookup audit skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async upsertSubscription(input: SubscriptionAuditInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const shop = await this.prisma.shop.findUnique({
        where: { orgid: input.orgid },
        select: { id: true },
      });
      const expiresAt = toDate(input.expiresAt);
      const syncedAt = toDate(input.syncedAt) || new Date();
      await this.prisma.subscriptionSnapshot.upsert({
        where: { orgid: input.orgid },
        create: {
          shopId: shop?.id,
          orgid: input.orgid,
          status: input.status,
          plan: input.plan,
          isActive: input.isActive,
          expiresAt,
          syncedAt,
          payload: this.toOptionalJson(input.payload),
        },
        update: {
          shopId: shop?.id,
          status: input.status,
          plan: input.plan,
          isActive: input.isActive,
          expiresAt,
          syncedAt,
          payload: this.toOptionalJson(input.payload),
        },
      });
      await this.prisma.shop.updateMany({
        where: { orgid: input.orgid },
        data: {
          status: input.status,
          plan: input.plan,
          expiresAt,
          subscriptionStatus: input.status,
          subscriptionUpdatedAt: syncedAt,
          subscriptionPayload: this.toOptionalJson(input.payload),
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB subscription audit skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async findSubscriptionSnapshot(
    orgid: string,
  ): Promise<SubscriptionSnapshotRecord | null> {
    if (!this.prisma) return null;
    try {
      const row = await this.prisma.subscriptionSnapshot.findUnique({
        where: { orgid },
      });
      if (!row) return null;
      return {
        orgid: row.orgid,
        status: row.status,
        plan: row.plan,
        is_active: row.isActive,
        expires_at: row.expiresAt?.getTime(),
        synced_at: row.syncedAt.getTime(),
        subscription_payload:
          row.payload &&
          typeof row.payload === 'object' &&
          !Array.isArray(row.payload)
            ? (row.payload as Record<string, unknown>)
            : undefined,
      };
    } catch (error) {
      this.logger.warn(
        `DB subscription read skipped: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  async recordWebhook(input: WebhookAuditInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const payloadString = JSON.stringify(input.payload || {});
      const payloadHash = crypto
        .createHash('sha256')
        .update(payloadString)
        .digest('hex');
      const shop = input.orgid
        ? await this.prisma.shop.findUnique({
            where: { orgid: input.orgid },
            select: { id: true },
          })
        : null;

      await this.prisma.webhookEvent.upsert({
        where: {
          topic_orgid_payloadHash: {
            topic: input.topic,
            orgid: input.orgid || '',
            payloadHash,
          },
        },
        create: {
          shopId: shop?.id,
          orgid: input.orgid || '',
          topic: input.topic,
          payloadHash,
          payload: this.toOptionalJson(input.payload),
          headers: this.toOptionalJson(input.headers),
          status: input.status,
          attempts: input.status === 'processed' ? 1 : 0,
          error: input.error,
          processedAt: input.status === 'processed' ? new Date() : null,
        },
        update: {
          shopId: shop?.id,
          status: input.status,
          attempts: { increment: 1 },
          error: input.error,
          processedAt: input.status === 'processed' ? new Date() : null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `DB webhook audit skipped: ${this.getErrorMessage(error)}`,
      );
    }
  }
}
