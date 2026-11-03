import type { RedisService } from '../../redis/redis.service';
import { RateLimitService } from './rate-limit.service';

class CounterRedis {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  readonly calls: string[] = [];
  private readonly expiresAt = new Map<string, number>();
  private clock = 0;

  incr = jest.fn((key: string, ttlSeconds: number) => {
    this.calls.push(key);
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && expiry <= this.clock) {
      this.counts.delete(key);
      this.expiresAt.delete(key);
    }
    if (!this.counts.has(key)) this.expiresAt.set(key, this.clock + ttlSeconds);
    this.ttls.set(key, ttlSeconds);
    const next = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  });

  seed(key: string, value: number) {
    this.counts.set(key, value);
  }

  advance(seconds: number) {
    this.clock += seconds;
  }
}

const setup = () => {
  const redis = new CounterRedis();
  const service = new RateLimitService(redis as unknown as RedisService);
  return { redis, service };
};

const IP_MIN = (store: string, ip: string) => `orlimit:ipmin:${store}:${ip}`;
const IP_HOUR = (store: string, ip: string) => `orlimit:iphour:${store}:${ip}`;
const STORE = (store: string) => `orlimit:store:${store}`;

describe('RateLimitService', () => {
  it('lets a normal request through and counts the store', async () => {
    const { redis, service } = setup();
    await expect(service.check('1.1.1.1', 'org_1')).resolves.toEqual({
      blocked: false,
      require_captcha: false,
    });
    expect(redis.counts.get(STORE('org_1'))).toBe(1);
  });

  it('does not count the store for a per-minute IP block', async () => {
    const { redis, service } = setup();
    redis.seed(IP_MIN('org_1', '1.1.1.1'), 60);

    const result = await service.check('1.1.1.1', 'org_1');

    expect(result).toEqual({
      blocked: true,
      require_captcha: false,
      reason: 'rate_limited',
    });
    expect(redis.calls).not.toContain(STORE('org_1'));
    expect(redis.counts.has(STORE('org_1'))).toBe(false);
  });

  it('does not count the store for an hourly IP block and reports it first', async () => {
    const { redis, service } = setup();
    redis.seed(IP_HOUR('org_1', '1.1.1.1'), 500);
    redis.seed(IP_MIN('org_1', '1.1.1.1'), 60);

    const result = await service.check('1.1.1.1', 'org_1');

    expect(result).toEqual({
      blocked: true,
      require_captcha: false,
      reason: 'ip_blocked',
    });
    expect(redis.calls).not.toContain(STORE('org_1'));
  });

  it('keeps a blocked client from exhausting the store budget of other clients', async () => {
    const { redis, service } = setup();
    redis.seed(IP_MIN('org_1', '1.1.1.1'), 60);
    for (let i = 0; i < 300; i += 1) await service.check('1.1.1.1', 'org_1');

    await expect(service.check('2.2.2.2', 'org_1')).resolves.toEqual({
      blocked: false,
      require_captcha: false,
    });
  });

  it('blocks the store once its own per-minute budget is spent', async () => {
    const { redis, service } = setup();
    redis.seed(STORE('org_1'), 200);
    await expect(service.check('3.3.3.3', 'org_1')).resolves.toEqual({
      blocked: true,
      require_captcha: false,
      reason: 'store_rate_limited',
    });
  });

  it('asks for a captcha above 120 requests per hour', async () => {
    const { redis, service } = setup();
    redis.seed(IP_HOUR('org_1', '1.1.1.1'), 120);
    await expect(service.check('1.1.1.1', 'org_1')).resolves.toEqual({
      blocked: false,
      require_captcha: true,
    });
  });

  it('keeps IP buckets separate per store, including IPv6 addresses', async () => {
    const { redis, service } = setup();
    const ip = '2001:db8::1';
    redis.seed(IP_MIN('org_1', ip), 60);

    await expect(service.check(ip, 'org_1')).resolves.toMatchObject({
      blocked: true,
    });
    await expect(service.check(ip, 'org_2')).resolves.toEqual({
      blocked: false,
      require_captcha: false,
    });
    expect(redis.counts.get(IP_MIN('org_2', ip))).toBe(1);
  });

  it('sets a 60 s window on the minute buckets and a 3600 s window on the hour bucket', async () => {
    const { redis, service } = setup();
    await service.check('1.1.1.1', 'org_1');
    expect(redis.ttls.get(IP_MIN('org_1', '1.1.1.1'))).toBe(60);
    expect(redis.ttls.get(IP_HOUR('org_1', '1.1.1.1'))).toBe(3600);
    expect(redis.ttls.get(STORE('org_1'))).toBe(60);
    expect(redis.calls).toHaveLength(3);
  });

  it('releases a minute block once its window expires while the hour counter keeps counting', async () => {
    const { redis, service } = setup();
    for (let i = 0; i < 60; i += 1) await service.check('1.1.1.1', 'org_1');
    await expect(service.check('1.1.1.1', 'org_1')).resolves.toMatchObject({
      blocked: true,
      reason: 'rate_limited',
    });

    redis.advance(61);

    await expect(service.check('1.1.1.1', 'org_1')).resolves.toEqual({
      blocked: false,
      require_captcha: false,
    });
    expect(redis.counts.get(IP_MIN('org_1', '1.1.1.1'))).toBe(1);
    expect(redis.counts.get(IP_HOUR('org_1', '1.1.1.1'))).toBe(62);
  });

  it('uses distinct key namespaces for minute and hour IP counters', async () => {
    const { redis, service } = setup();
    await service.check('1.1.1.1', 'org_1');
    expect(redis.calls).toEqual(
      expect.arrayContaining([
        IP_MIN('org_1', '1.1.1.1'),
        IP_HOUR('org_1', '1.1.1.1'),
        STORE('org_1'),
      ]),
    );
    expect(new Set(redis.calls).size).toBe(redis.calls.length);
  });
});
