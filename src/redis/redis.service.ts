import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  async set(key: string, value: unknown, ttl?: number) {
    const val = JSON.stringify(value);
    if (ttl) {
      await this.client.set(key, val, 'EX', ttl);
    } else {
      await this.client.set(key, val);
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
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
   * Atomic increment with TTL (for rate limiting).
   * Uses Redis INCR + EXPIRE pipeline — no race conditions.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const pipeline = this.client.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds);
    const results = await pipeline.exec();
    if (!results || !results[0]) return 1;
    return results[0][1] as number;
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
