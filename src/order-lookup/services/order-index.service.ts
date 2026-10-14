import {
  Injectable,
  Inject,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios, { AxiosError } from 'axios';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { HaravanService } from '../../haravan/haravan.service';
import { normalizeLookupPhone } from '../utils/phone.util';
import type { HaravanOrder } from './haravan-order.service';
import { setTimeout as sleep } from 'timers/promises';

type ExtractedOrder = {
  id: string;
  orderNumber: string;
  orderName: string;
  phoneKeys: string[];
  createdAt: Date | null;
  updatedAt: Date | null;
  cancelledAt: Date | null;
  rawJson: string;
};

const toDateSafe = (val: unknown): Date | null => {
  if (!val) return null;
  const d = new Date(val as string | number | Date);
  return isNaN(d.getTime()) ? null : d;
};
export function extractOrderData(
  order: unknown,
  hashPhoneFn: (phone: string) => string,
): ExtractedOrder | null {
  if (!order || typeof order !== 'object') return null;

  const rec = order as Record<string, unknown>;
  const rawId = rec.id;
  if (rawId === undefined || rawId === null) return null;
  const id = String(rawId);

  const rawOrderNumber = rec.order_number ?? '';
  const orderNumber = String(rawOrderNumber).replace(/^#/, '').toLowerCase().trim();

  const rawName = rec.name ?? '';
  const orderName = String(rawName).replace(/^#/, '').toLowerCase().trim();

  const rawPhones: string[] = [];
  if (typeof rec.phone === 'string') rawPhones.push(rec.phone);

  const customer =
    typeof rec.customer === 'object' && rec.customer !== null
      ? (rec.customer as Record<string, unknown>)
      : null;
  if (customer && typeof customer.phone === 'string') {
    rawPhones.push(customer.phone);
  }
  const defaultAddress =
    customer &&
    typeof customer.default_address === 'object' &&
    customer.default_address !== null
      ? (customer.default_address as Record<string, unknown>)
      : null;
  if (defaultAddress && typeof defaultAddress.phone === 'string') {
    rawPhones.push(defaultAddress.phone);
  }

  const billing =
    typeof rec.billing_address === 'object' && rec.billing_address !== null
      ? (rec.billing_address as Record<string, unknown>)
      : null;
  if (billing && typeof billing.phone === 'string') {
    rawPhones.push(billing.phone);
  }

  const shipping =
    typeof rec.shipping_address === 'object' && rec.shipping_address !== null
      ? (rec.shipping_address as Record<string, unknown>)
      : null;
  if (shipping && typeof shipping.phone === 'string') {
    rawPhones.push(shipping.phone);
  }

  const normalizedPhones = new Set<string>();
  for (const rawPhone of rawPhones) {
    const normalized = normalizeLookupPhone(rawPhone);
    if (normalized) {
      normalizedPhones.add(normalized);
    }
  }

  const phoneKeys: string[] = [];
  for (const normPhone of normalizedPhones) {
    const key = hashPhoneFn(normPhone);
    if (key && !phoneKeys.includes(key)) {
      phoneKeys.push(key);
    }
  }

  return {
    id,
    orderNumber,
    orderName,
    phoneKeys,
    createdAt: toDateSafe(rec.created_at),
    updatedAt: toDateSafe(rec.updated_at),
    cancelledAt: toDateSafe(rec.cancelled_at),
    rawJson: JSON.stringify(order),
  };
}

@Injectable()
export class OrderIndexService {
  private readonly logger = new Logger(OrderIndexService.name);
  private readonly activeBackfills = new Set<string>();

  constructor(
    private readonly prismaService: PrismaService,
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => HaravanService))
    private readonly haravanService: HaravanService,
    private readonly configService: ConfigService,
  ) {}

  async isReady(orgid: string): Promise<boolean> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid) return false;
    try {
      const syncState = await client.orderSyncState.findUnique({
        where: { orgid },
        select: { status: true, backfillVersion: true },
      });
      if (syncState?.status !== 'ready') return false;
      if (
        typeof syncState.backfillVersion === 'number' &&
        syncState.backfillVersion < 2
      ) {
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to check isReady for orgid=${orgid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async upsertOrder(orgid: string, order: unknown): Promise<void> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid) return;

    const data = extractOrderData(order, (p) =>
      this.prismaService.hashPhone(p),
    );
    if (!data) return;

    if (typeof client.orderIndex.findUnique === 'function' && data.updatedAt) {
      const existing = await client.orderIndex.findUnique({
        where: {
          orgid_haravanOrderId: {
            orgid,
            haravanOrderId: data.id,
          },
        },
        select: {
          haravanUpdatedAt: true,
          cancelledAt: true,
        },
      });
      if (
        existing?.haravanUpdatedAt &&
        existing.haravanUpdatedAt.getTime() > data.updatedAt.getTime() &&
        (!data.cancelledAt || existing.cancelledAt)
      ) {
        this.logger.debug(
          `Skipping stale order update for orgid=${orgid}, order=${data.id}`,
        );
        return;
      }
    }

    const encrypted = this.prismaService.encrypt(data.rawJson);
    if (!encrypted) {
      this.logger.warn(`Failed to encrypt payload for order id=${data.id}`);
      return;
    }

    await client.orderIndex.upsert({
      where: {
        orgid_haravanOrderId: {
          orgid,
          haravanOrderId: data.id,
        },
      },
      create: {
        orgid,
        haravanOrderId: data.id,
        orderNumber: data.orderNumber,
        orderName: data.orderName,
        phoneKeys: data.phoneKeys,
        payloadCiphertext: encrypted.ciphertext,
        payloadIv: encrypted.iv,
        payloadTag: encrypted.tag,
        haravanCreatedAt: data.createdAt,
        haravanUpdatedAt: data.updatedAt,
        cancelledAt: data.cancelledAt,
      },
      update: {
        orderNumber: data.orderNumber,
        orderName: data.orderName,
        phoneKeys: data.phoneKeys,
        payloadCiphertext: encrypted.ciphertext,
        payloadIv: encrypted.iv,
        payloadTag: encrypted.tag,
        haravanCreatedAt: data.createdAt,
        haravanUpdatedAt: data.updatedAt,
        cancelledAt: data.cancelledAt,
      },
    });
  }

  async deleteOrder(orgid: string, haravanOrderId: string): Promise<void> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid || !haravanOrderId) {
      return;
    }

    await client.orderIndex.deleteMany({
      where: {
        orgid,
        haravanOrderId: String(haravanOrderId),
      },
    });
  }

  async purgeOrg(orgid: string): Promise<void> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid) return;

    await client.$transaction([
      client.orderIndex.deleteMany({ where: { orgid } }),
      client.orderSyncState.deleteMany({ where: { orgid } }),
    ]);
  }

  async search(
    orgid: string,
    phone?: string,
    code?: string,
    limit = 5,
  ): Promise<HaravanOrder[]> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid) return [];

    const normalizedPhone = phone ? normalizeLookupPhone(phone) : '';
    const normalizedCode = code ? code.replace(/^#/, '').toLowerCase().trim() : '';

    if (!normalizedPhone && !normalizedCode) {
      return [];
    }

    const where: Prisma.OrderIndexWhereInput = {
      orgid,
    };

    if (normalizedPhone) {
      const phoneKey = this.prismaService.hashPhone(normalizedPhone);
      where.phoneKeys = { has: phoneKey };
    }

    if (normalizedCode) {
      where.OR = [
        { orderNumber: normalizedCode },
        { orderName: normalizedCode },
      ];
    }

    const rows = await client.orderIndex.findMany({
      where,
      orderBy: [
        { haravanCreatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: limit,
    });

    const orders: HaravanOrder[] = [];
    for (const row of rows) {
      const decrypted = this.prismaService.decrypt({
        ciphertext: row.payloadCiphertext,
        iv: row.payloadIv,
        tag: row.payloadTag,
      });
      if (decrypted) {
        try {
          const parsed = JSON.parse(decrypted) as HaravanOrder;
          orders.push(parsed);
        } catch {
          this.logger.warn(
            `Failed to parse decrypted order JSON for order=${row.haravanOrderId}`,
          );
        }
      }
    }

    return orders;
  }

  async ensureBackfill(orgid: string): Promise<void> {
    if (!this.prismaService.enabled || !this.prismaService.client || !orgid) {
      return;
    }
    if (this.activeBackfills.has(orgid)) return;

    const isReady = await this.isReady(orgid);
    if (isReady) return;

    const lockKey = `checkorders:backfill:lock:${orgid}`;
    if (await this.redisService.has(lockKey)) return;
    try {
      const accessToken = await this.haravanService.resolveAccessToken(orgid);
      if (!accessToken) return;
      await this.backfill(orgid, accessToken);
    } catch (error) {
      this.logger.warn(
        `ensureBackfill failed for orgid=${orgid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async backfill(orgid: string, accessToken: string): Promise<void> {
    const client = this.prismaService.client;
    if (!this.prismaService.enabled || !client || !orgid || !accessToken) {
      return;
    }

    if (this.activeBackfills.has(orgid)) {
      this.logger.debug(`Backfill already in flight in process for ${orgid}`);
      return;
    }

    const lockKey = `checkorders:backfill:lock:${orgid}`;
    const acquired = await this.redisService.setNx(lockKey, '1', 600);
    if (!acquired) {
      this.logger.debug(`Backfill lock held in Redis for ${orgid}`);
      return;
    }

    this.activeBackfills.add(orgid);

    try {
      const syncState = await client.orderSyncState.findUnique({
        where: { orgid },
      });
      const isV2Backfill =
        typeof syncState?.backfillVersion !== 'number' ||
        syncState.backfillVersion >= 2;
      if (syncState?.status === 'ready' && isV2Backfill) {
        return;
      }

      let page =
        syncState?.status === 'ready' && !isV2Backfill
          ? 1
          : syncState?.nextPage || 1;
      let indexedCount =
        syncState?.status === 'ready' && !isV2Backfill
          ? 0
          : syncState?.indexedCount || 0;
      await client.orderSyncState.upsert({
        where: { orgid },
        create: {
          orgid,
          status: 'running',
          nextPage: page,
          indexedCount,
          startedAt: new Date(),
          lastError: null,
        },
        update: {
          status: 'running',
          startedAt: new Date(),
          lastError: null,
        },
      });

      const MAX_PAGE_RETRIES = 3;
      const pageRetries = new Map<number, number>();

      while (true) {
        const url = `https://apis.haravan.com/com/orders.json?status=any&limit=50&page=${page}`;
        let response;
        try {
          response = await axios.get<{ orders?: unknown[] }>(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15_000,
          });
        } catch (error: unknown) {
          if (axios.isAxiosError(error)) {
            const axErr = error as AxiosError;
            if (axErr.response?.status === 429) {
              const retries = (pageRetries.get(page) || 0) + 1;
              pageRetries.set(page, retries);
              if (retries > MAX_PAGE_RETRIES) {
                throw new Error(
                  `Haravan rate limit retries exceeded on page ${page}`,
                );
              }
              const retryAfterHeader =
                axErr.response.headers?.['retry-after'];
              const retryAfter = Number(retryAfterHeader) || 2;
              this.logger.warn(
                `Haravan rate limited on backfill for ${orgid}, waiting ${retryAfter}s...`,
              );
              await sleep(retryAfter * 1000);
              continue;
            }
          }
          throw error;
        }

        const orders = response.data?.orders || [];
        for (const order of orders) {
          await this.upsertOrder(orgid, order);
        }

        indexedCount += orders.length;

        if (orders.length < 50) {
          await client.orderSyncState.update({
            where: { orgid },
            data: {
              status: 'ready',
              backfillVersion: 2,
              nextPage: page,
              indexedCount,
              finishedAt: new Date(),
              lastError: null,
            },
          });
          this.logger.log(
            `Order backfill completed for ${orgid}: indexed ${indexedCount} orders across ${page} pages`,
          );
          break;
        }

        page++;
        await client.orderSyncState.update({
          where: { orgid },
          data: {
            nextPage: page,
            indexedCount,
          },
        });
        await this.redisService.set(lockKey, '1', 600);
        await sleep(600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Order backfill failed for orgid=${orgid}: ${message}`);
      await client.orderSyncState.updateMany({
        where: { orgid },
        data: {
          status: 'failed',
          lastError: message,
        },
      });
    } finally {
      this.activeBackfills.delete(orgid);
      await this.redisService.del(lockKey).catch(() => {});
    }
  }
}
