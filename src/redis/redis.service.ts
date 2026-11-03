import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  isSealed,
  open,
  resolveEnvelopeKey,
  seal,
} from '../common/secret-envelope';

/**
 * Writer switch for Haravan token sealing. The reader accepts both plaintext
 * and sealed records regardless; the writer is enabled only after the reader
 * is live everywhere, so a rollback never meets ciphertext it cannot read.
 */
export const SEAL_REDIS_TOKENS_ON_WRITE = false;

const TOKEN_FIELDS = ['access_token', 'refresh_token'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly tokenKey: Buffer | null;
  protected sealOnWrite: boolean = SEAL_REDIS_TOKENS_ON_WRITE;

  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    @Optional() config?: ConfigService,
  ) {
    this.tokenKey = resolveEnvelopeKey(
      config?.get<string>('DATA_ENCRYPTION_KEY'),
    );
  }

  async set(key: string, value: unknown, ttl?: number) {
    const val = JSON.stringify(this.sealTokenFields(value));
    if (ttl) {
      await this.client.set(key, val, 'EX', ttl);
    } else {
      await this.client.set(key, val);
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    if (!val) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch {
      return null;
    }
    return this.openTokenFields(key, parsed) as T | null;
  }

  /** Writes plaintext when no key is configured; never mutates the caller's object. */
  private sealTokenFields(value: unknown): unknown {
    if (!this.sealOnWrite || !this.tokenKey || !isPlainObject(value)) {
      return value;
    }
    const copy: Record<string, unknown> = { ...value };
    for (const field of TOKEN_FIELDS) {
      const token = copy[field];
      if (typeof token === 'string' && token && !isSealed(token)) {
        copy[field] = seal(this.tokenKey, token);
      }
    }
    return copy;
  }

  /**
   * Plaintext fields pass through (records written before sealing). A sealed
   * field that cannot be opened makes the whole record a miss: callers fall
   * back to the database instead of using an empty or ciphertext token.
   */
  private openTokenFields(key: string, value: unknown): unknown {
    if (!isPlainObject(value)) return value;
    let copy: Record<string, unknown> | null = null;
    for (const field of TOKEN_FIELDS) {
      const token = value[field];
      if (!isSealed(token)) continue;
      const plain = open(this.tokenKey, token);
      if (plain === null) {
        this.logger.warn(
          `Failed to decrypt redis token field ${field} for key ${key}`,
        );
        return null;
      }
      copy ??= { ...value };
      copy[field] = plain;
    }
    return copy ?? value;
  }

  /**
   * SCAN-based key search (non-blocking, production-safe).
   * Replaces KEYS which is O(N) and blocks Redis.
   */
  async getKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Atomic fixed-window counter: the TTL is set only when the window opens,
   * so repeated hits cannot keep extending a lockout.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.client
      .pipeline()
      .set(key, '0', 'EX', ttlSeconds, 'NX')
      .incr(key)
      .ttl(key)
      .exec();
    const count = Number(results?.[1]?.[1]) || 1;
    if (Number(results?.[2]?.[1]) === -1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  /**
   * SET if Not eXists — for distributed locking.
   * Returns true if key was set (lock acquired), false if already exists.
   */
  async setNx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async del(key: string): Promise<number> {
    return await this.client.del(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  /** Alias for getKeys — matches reference repo naming */
  async scanKeys(pattern: string): Promise<string[]> {
    return this.getKeys(pattern);
  }

  onModuleDestroy() {
    void this.client.quit();
  }
}
