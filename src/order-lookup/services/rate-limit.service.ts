import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

export interface RateLimitResult {
  blocked: boolean;
  require_captcha: boolean;
  reason?: 'rate_limited' | 'store_rate_limited' | 'ip_blocked';
}

const IP_MINUTE_PREFIX = 'orlimit:ipmin';
const STORE_MINUTE_PREFIX = 'orlimit:store';
const IP_HOUR_PREFIX = 'orlimit:iphour';

/**
 * RateLimitService
 *
 * Redis-based sliding window rate limiting.
 * Tiers:
 *  L1: 60 req/min per IP
 *  L2: 200 req/min per store
 *  L3: 120 req/hour per IP → require CAPTCHA
 *  L4: 500 req/hour per IP → block
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  async check(ip: string, storeId: string): Promise<RateLimitResult> {
    // The store id never contains ':', so the IP (which may be IPv6) is last.
    const ipMinKey = `${IP_MINUTE_PREFIX}:${storeId}:${ip}`;
    const ipHourKey = `${IP_HOUR_PREFIX}:${storeId}:${ip}`;
    const storeMinKey = `${STORE_MINUTE_PREFIX}:${storeId}`;

    const [ipMinCount, ipHourCount] = await Promise.all([
      this.increment(ipMinKey, 60),
      this.increment(ipHourKey, 3600),
    ]);

    // L4: IP blocked (500 req/hour)
    if (ipHourCount > 500) {
      this.logger.warn(`IP blocked (L4): ${ip} — ${ipHourCount} req/hour`);
      return { blocked: true, require_captcha: false, reason: 'ip_blocked' };
    }

    // L1: IP rate limited (60 req/min)
    if (ipMinCount > 60) {
      this.logger.warn(`IP rate limited (L1): ${ip} — ${ipMinCount} req/min`);
      return { blocked: true, require_captcha: false, reason: 'rate_limited' };
    }

    // Only requests that passed the per-IP limits count against the store, so
    // one abusive client cannot exhaust the store budget for everyone else.
    const storeMinCount = await this.increment(storeMinKey, 60);

    // L2: Store rate limited (200 req/min)
    if (storeMinCount > 200) {
      this.logger.warn(
        `Store rate limited (L2): ${storeId} — ${storeMinCount} req/min`,
      );
      return {
        blocked: true,
        require_captcha: false,
        reason: 'store_rate_limited',
      };
    }

    // L3: Require CAPTCHA (120 req/hour per IP)
    if (ipHourCount > 120) {
      return { blocked: false, require_captcha: true };
    }

    return { blocked: false, require_captcha: false };
  }

  /**
   * Atomic increment via Redis INCR pipeline.
   */
  private async increment(key: string, ttlSeconds: number): Promise<number> {
    return this.redis.incr(key, ttlSeconds);
  }
}
