import type { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import axios from 'axios';
import * as crypto from 'crypto';
import { HaravanService } from './haravan.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

const ISSUER = 'https://accounts.haravan.com';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const CLIENT_ID = 'client-id';

type RedisEntry = {
  value: unknown;
  expiresAt?: number;
};

class RedisMock {
  readonly store = new Map<string, RedisEntry>();

  set(key: string, value: unknown, ttl?: number) {
    this.store.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
    });
  }

  get<T = unknown>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  del(key: string): number {
    return this.store.delete(key) ? 1 : 0;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  getKeys(pattern: string): string[] {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }

  setNx(key: string, value: string, ttl: number): boolean {
    if (this.has(key)) return false;
    this.set(key, value, ttl);
    return true;
  }
}

const makeConfig = (): ConfigService =>
  ({
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        FRONTEND_URL: 'http://localhost:5173',
        HRV_URL_AUTHORIZE: `${ISSUER}/connect/authorize`,
        HRV_URL_CONNECT_TOKEN: `${ISSUER}/connect/token`,
        HRV_CLIENT_ID: CLIENT_ID,
        HRV_CLIENT_SECRET: 'client-secret',
        APP_SESSION_SECRET: 'session-secret',
        HRV_WEBHOOK_SECRET: 'webhook-secret',
        HRV_WEBHOOK_URL: 'https://api.example.com/api/oauth/install/webhooks',
        HRV_LOGIN_CALLBACK_URL: 'http://localhost:5173/install/login',
        HRV_INSTALL_CALLBACK_URL:
          'http://localhost:3333/api/oauth/install/grandservice',
        HRV_SCOPE_LOGIN: 'openid profile org',
        HRV_SCOPE_INSTALL: 'openid profile org grant_service offline_access',
        HRV_GRANT_TYPE_INSTALL: 'authorization_code',
        HRV_GRANT_TYPE_REFRESH: 'refresh_token',
        HRV_RESPONSE_TYPE: 'code',
        HRV_OIDC_ISSUER: ISSUER,
        HRV_OIDC_DISCOVERY_URL: DISCOVERY_URL,
      };
      return values[key];
    }),
  }) as unknown as ConfigService;

type MockResponse = Partial<Response> & {
  cookie: jest.Mock;
  json: jest.Mock;
  redirect: jest.Mock;
  status: jest.Mock;
  jsonPayloads: unknown[];
};

const createResponse = (): MockResponse => {
  const jsonPayloads: unknown[] = [];
  const res = {
    cookie: jest.fn(),
    json: jest.fn((payload: unknown) => {
      jsonPayloads.push(payload);
    }),
    redirect: jest.fn(),
    status: jest.fn(),
    jsonPayloads,
  } as MockResponse;
  res.status.mockReturnValue(res);
  return res;
};

const toBase64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const signIdToken = (
  privateKey: crypto.KeyObject,
  kid: string,
  claims: Record<string, unknown>,
): string => {
  const header = toBase64UrlJson({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = toBase64UrlJson(claims);
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
};

describe('HaravanService OAuth security', () => {
  const kid = 'test-key';
  let privateKey: crypto.KeyObject;
  let publicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };

  beforeAll(() => {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keyPair.privateKey;
    const exportedJwk = keyPair.publicKey.export({ format: 'jwk' });
    publicJwk = {
      ...exportedJwk,
      kid,
      alg: 'RS256',
      use: 'sig',
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockImplementation((url: string) => {
      if (url === DISCOVERY_URL) {
        return Promise.resolve({
          data: { issuer: ISSUER, jwks_uri: JWKS_URL },
        });
      }
      if (url === JWKS_URL) {
        return Promise.resolve({ data: { keys: [publicJwk] } });
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  const createService = () => {
    const redis = new RedisMock();
    const storeService = {
      getStoreByDomain: jest.fn(),
      getStoreByOrgId: jest.fn(),
      registerStore: jest.fn(),
      deactivateStore: jest.fn(),
    };
    const db = {
      upsertInstallSession: jest.fn().mockResolvedValue(undefined),
      findInstallSession: jest.fn().mockResolvedValue(null),
      clearTokensForUninstall: jest.fn().mockResolvedValue(undefined),
      recordWebhook: jest.fn().mockResolvedValue(undefined),
      upsertSubscription: jest.fn().mockResolvedValue(undefined),
      upsertSubscriptionSnapshot: jest.fn().mockResolvedValue(undefined),
      findSubscriptionSnapshot: jest.fn().mockResolvedValue(null),
      markShopInactive: jest.fn().mockResolvedValue(undefined),
    };
    const notificationService = { notify: jest.fn().mockResolvedValue(undefined) };
    const orderIndexService = {
      upsertOrder: jest.fn().mockResolvedValue(undefined),
      deleteOrder: jest.fn().mockResolvedValue(undefined),
      purgeOrg: jest.fn().mockResolvedValue(undefined),
      ensureBackfill: jest.fn().mockResolvedValue(undefined),
    };
    const haravanApi = {
      getShop: jest.fn().mockResolvedValue({}),
      getAppSubscriptions: jest.fn().mockResolvedValue([]),
    };
    const service = new HaravanService(
      makeConfig(),
      redis as never,
      haravanApi as never,
      storeService as never,
      notificationService as never,
      db as never,
      orderIndexService as never,
    );
    return { service, redis, storeService, db, notificationService, orderIndexService, haravanApi };
  };
  const tokenClaims = (nonce: string, overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      nonce,
      orgid: 'org_1',
      ...overrides,
    };
  };

  it('creates one-time state and verifies a signed login id_token', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_1', {
      access_token: 'old-access-token',
      status: 'trial',
    });

    const loginUrl = new URL((await service.loginApp('org_1')).url);
    const state = loginUrl.searchParams.get('state') || '';
    const nonce = loginUrl.searchParams.get('nonce') || '';
    expect(state).toMatch(/^f1g_oauth_[a-f0-9]{64}$/);
    expect(nonce).toMatch(/^f1g_nonce_[a-f0-9]{64}$/);

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id_token: signIdToken(privateKey, kid, tokenClaims(nonce)),
      },
    });

    const res = createResponse();
    await service.processLoginCallback(
      'oauth-code',
      state,
      { headers: { accept: 'application/json' } } as Request,
      res as Response,
    );

    const payload = res.jsonPayloads[0] as {
      orgid?: string;
      sessionToken?: unknown;
      url?: string;
    };
    expect(payload.orgid).toBe('org_1');
    expect(typeof payload.sessionToken).toBe('string');
    expect(payload.url || '').not.toContain('session_token=');
    expect(res.cookie).not.toHaveBeenCalled();

    const replayRes = createResponse();
    await service.processLoginCallback(
      'oauth-code',
      state,
      { headers: { accept: 'application/json' } } as Request,
      replayRes as Response,
    );

    expect(replayRes.status).toHaveBeenCalledWith(400);
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('uses id_token orgid when the requested orgid is stale', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_1', {
      access_token: 'old-access-token',
      status: 'trial',
    });

    const loginUrl = new URL((await service.loginApp('stale_org')).url);
    const state = loginUrl.searchParams.get('state') || '';
    const nonce = loginUrl.searchParams.get('nonce') || '';

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id_token: signIdToken(privateKey, kid, tokenClaims(nonce)),
      },
    });

    const res = createResponse();
    await service.processLoginCallback(
      'oauth-code',
      state,
      { headers: { accept: 'application/json' } } as Request,
      res as Response,
    );

    expect(res.status).not.toHaveBeenCalledWith(400);
    const payload = res.jsonPayloads[0] as {
      orgid?: string;
      sessionToken?: unknown;
    };
    expect(payload.orgid).toBe('org_1');
    expect(typeof payload.sessionToken).toBe('string');
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rejects a signed id_token with the wrong audience', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_1', {
      access_token: 'old-access-token',
      status: 'trial',
    });

    const loginUrl = new URL((await service.loginApp('org_1')).url);
    const state = loginUrl.searchParams.get('state') || '';
    const nonce = loginUrl.searchParams.get('nonce') || '';
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id_token: signIdToken(
          privateKey,
          kid,
          tokenClaims(nonce, { aud: 'other-client' }),
        ),
      },
    });

    const res = createResponse();
    await service.processLoginCallback(
      'oauth-code',
      state,
      { headers: { accept: 'application/json' } } as Request,
      res as Response,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const jsonPayload = res.jsonPayloads[0] as { error?: unknown } | undefined;
    expect(String(jsonPayload?.error)).toContain('audience');
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('requires OAuth SSO when shop and orgid match but no signed HMAC is present', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'old-access-token',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      status: 'trial',
      primary_domain: 'shop.myharavan.com',
    });

    const result = await service.loginApp('org_1', 'shop.myharavan.com');

    expect(result.orgid).toBeUndefined();
    expect(result.sessionToken).toBeUndefined();
    expect(result.url).toContain('/connect/authorize');
    expect(
      redis.get('haravan:checkorders:shop_domain:shop.myharavan.com'),
    ).toBe('org_1');
  });

  it('does not create a session when shop mapping belongs to another orgid', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:shop_domain:shop.myharavan.com', 'org_2');
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'old-access-token',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      status: 'trial',
      primary_domain: 'shop.myharavan.com',
    });

    const result = await service.loginApp('org_1', 'shop.myharavan.com');

    expect(result.sessionToken).toBeUndefined();
    expect(result.url).toContain('/connect/authorize');
  });

  it('syncs active subscription webhook after raw-body HMAC verification', async () => {
    const { service, redis } = createService();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const body = {
      app_subscription: {
        status: 'active',
        expires_at: expiresAt.toISOString(),
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');

    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'old-access-token',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      status: 'trial',
      primary_domain: 'shop.myharavan.com',
    });

    const result = await service.handleWebhook({
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'app_subscriptions/update',
        'x-haravan-org-id': 'org_1',
      },
    } as unknown as Request & { rawBody: Buffer });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, orgid: 'org_1' }),
    );
    expect(redis.get('haravan:checkorders:app_subscriptions:org_1')).toEqual(
      expect.objectContaining({
        orgid: 'org_1',
        status: 'active',
        plan: 'Pro',
        is_active: true,
      }),
    );
    expect(redis.get('haravan:checkorders:app_install:org_1')).toEqual(
      expect.objectContaining({
        status: 'active',
        plan: 'Pro',
        subscription_status: 'active',
      }),
    );
    expect(
      redis.store.get('haravan:checkorders:app_install:org_1')?.expiresAt,
    ).toBeUndefined();
  });

  it('reconciles the paid plan from Haravan when the webhook never arrived', async () => {
    const { service, redis, haravanApi } = createService();
    const paidUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'live-token',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      status: 'trial',
      plan: 'Trial',
      expires_at: Date.now() - 60 * 1000,
    });
    haravanApi.getAppSubscriptions.mockResolvedValueOnce([
      { client_id: 'another-app', status: 'active', expired_at: '2099-01-01T00:00:00Z' },
      { client_id: CLIENT_ID, status: 'canceled', cancelled_at: '2026-01-01T00:00:00Z', expired_at: '2026-02-01T00:00:00Z' },
      { client_id: CLIENT_ID, status: 'active', cancelled_at: null, expired_at: paidUntil.toISOString() },
    ]);

    const snapshot = await service.reconcileSubscription('org_1');

    expect(haravanApi.getAppSubscriptions).toHaveBeenCalledWith('live-token');
    expect(snapshot).toEqual(
      expect.objectContaining({ status: 'active', plan: 'Pro', is_active: true, expires_at: paidUntil.getTime() }),
    );
    expect(redis.get('haravan:checkorders:app_install:org_1')).toEqual(
      expect.objectContaining({ status: 'active', plan: 'Pro', expires_at: paidUntil.getTime() }),
    );
  });

  it('stops the paid plan when its paid period has ended without renewal', async () => {
    const { service, redis, haravanApi } = createService();
    const endedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'live-token',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      status: 'active',
      plan: 'Pro',
      subscription_status: 'active',
      expires_at: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
    });
    haravanApi.getAppSubscriptions.mockResolvedValueOnce([
      { client_id: CLIENT_ID, status: 'active', cancelled_at: null, expired_at: endedAt.toISOString() },
    ]);

    await service.reconcileSubscription('org_1');

    expect(redis.get('haravan:checkorders:app_install:org_1')).toEqual(
      expect.objectContaining({ status: 'lapsed', plan: 'Free', expires_at: endedAt.getTime() }),
    );
  });

  it('keeps Pro app session available when token was marked invalid_grant', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'stale-access-token',
      refresh_token: 'bad-refresh-token',
      token_expires_at: Date.now() - 60 * 1000,
      status: 'needs_reinstall',
      plan: 'Pro',
      subscription_status: 'active',
      haravan_token_status: 'invalid_grant',
    });

    await expect(service.resolveAccessToken('org_1')).resolves.toBe(
      'stale-access-token',
    );
  });

  it('throws UnauthorizedException when a non-Pro session has an expired access token and no refresh token', async () => {
    const { service, redis } = createService();
    redis.set('haravan:checkorders:app_install:org_expired_trial', {
      orgid: 'org_expired_trial',
      access_token: 'stale-trial-token',
      token_expires_at: Date.now() - 60 * 1000,
      status: 'trial',
      plan: 'Trial',
    });

    await expect(
      service.resolveAccessToken('org_expired_trial'),
    ).rejects.toThrow('Session expired, please login again');
  });
  it('rejects install callback without OAuth state', async () => {
    const { service } = createService();
    const res = createResponse();

    await service.installApp('oauth-code', undefined, res as Response);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=install_failed'),
    );
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('does not push a PREMIUM_ORGIDS shop through reinstall after uninstall', async () => {
    process.env.PREMIUM_ORGIDS = 'org_1';
    try {
      const { service, redis } = createService();
      redis.set('haravan:checkorders:app_install:org_1', {
        orgid: 'org_1',
        status: 'uninstalled',
        plan: 'Trial',
        expires_at: Date.parse('2026-06-04T00:00:00Z'),
      });

      const launchUrl = new URL((await service.loginApp('org_1')).url);
      expect(launchUrl.searchParams.get('redirect_uri')).not.toContain(
        'grandservice',
      );
      expect(launchUrl.searchParams.get('redirect_uri')).toContain(
        '/install/login',
      );
    } finally {
      delete process.env.PREMIUM_ORGIDS;
    }
  });

  it('keeps the original trial expiry when an uninstalled shop reinstalls', async () => {
    const { service, redis, storeService } = createService();
    const usedTrialExpiry = Date.parse('2026-06-04T00:00:00Z');
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      status: 'uninstalled',
      plan: 'Trial',
      expires_at: usedTrialExpiry,
      installed_at: Date.parse('2026-05-28T00:00:00Z'),
    });

    const installUrl = new URL((await service.loginApp('org_1')).url);
    const state = installUrl.searchParams.get('state') || '';
    const nonce = installUrl.searchParams.get('nonce') || '';
    mockedAxios.post.mockResolvedValue({
      data: {
        id_token: signIdToken(privateKey, kid, tokenClaims(nonce)),
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      },
    });

    await service.installApp('oauth-code', state, createResponse() as Response);

    const saved = redis.get<{ expires_at?: number; status?: string }>(
      'haravan:checkorders:app_install:org_1',
    );
    expect(saved?.expires_at).toBe(usedTrialExpiry);
    expect(saved?.status).toBe('trial');
    expect(storeService.registerStore.mock.calls[0][5]).toEqual(
      expect.objectContaining({ expiresAt: usedTrialExpiry }),
    );
  });

  describe('session revocation marker on install', () => {
    const MARKER = 'haravan:checkorders:session_revoked_before:org_1';
    const NOW = () => Math.floor(Date.now() / 1000);

    const runInstall = async (
      existing: Record<string, unknown> | null,
    ): Promise<{
      service: HaravanService;
      redis: RedisMock;
      order: string[];
    }> => {
      const { service, redis } = createService();
      if (existing) {
        redis.set('haravan:checkorders:app_install:org_1', {
          orgid: 'org_1',
          ...existing,
        });
      }
      const installUrl = new URL(
        await (
          service as unknown as { buildUrlInstall(): Promise<string> }
        ).buildUrlInstall(),
      );
      const state = installUrl.searchParams.get('state') || '';
      const nonce = installUrl.searchParams.get('nonce') || '';
      mockedAxios.post.mockResolvedValue({
        data: {
          id_token: signIdToken(privateKey, kid, tokenClaims(nonce)),
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        },
      });
      const order: string[] = [];
      const set = redis.set.bind(redis);
      jest.spyOn(redis, 'set').mockImplementation((key, value, ttl) => {
        if (key === MARKER) order.push('marker');
        if (key === 'haravan:checkorders:app_install:org_1') order.push('install');
        set(key, value, ttl);
      });
      await service.installApp('oauth-code', state, createResponse() as Response);
      return { service, redis, order };
    };

    it('writes the marker before anything else on a first install', async () => {
      const { redis, order } = await runInstall(null);

      expect(order.slice(0, 2)).toEqual(['marker', 'install']);
      expect(redis.get<number>(MARKER)).toBeLessThanOrEqual(NOW());
      expect(redis.get<number>(MARKER)).toBeGreaterThan(NOW() - 5);
    });

    it('writes the marker on a reinstall after uninstall', async () => {
      const { order } = await runInstall({ status: 'uninstalled' });
      expect(order[0]).toBe('marker');
    });

    it('does not write the marker when the app is still installed', async () => {
      const { redis, order } = await runInstall({
        status: 'active',
        access_token: 'old-access-token',
      });
      expect(order).not.toContain('marker');
      expect(redis.get(MARKER)).toBeNull();
    });

    it('lets the session minted after a fresh install pass and rejects an older one', async () => {
      const { service, redis } = await runInstall(null);
      const marker = redis.get<number>(MARKER) as number;
      const minted = service.verifySessionToken(
        (
          service as unknown as { createSessionToken(orgid: string): string }
        ).createSessionToken('org_1'),
      );

      await expect(service.assertSessionNotRevoked(minted)).resolves.toBeUndefined();
      await expect(
        service.assertSessionNotRevoked({ ...minted, iat: marker - 1 }),
      ).rejects.toThrow('Auth session revoked');
    });
  });
  it('handles app uninstall webhook without deleting reinstall data', async () => {
    const { service, redis, storeService, db, orderIndexService } = createService();
    const body = {
      orgid: 'org_1',
      shop_domain: 'hangquoctai.myharavan.com',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');

    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
      status: 'active',
      plan: 'Pro',
      primary_domain: 'hangquoctai.myharavan.com',
    });
    redis.set(
      'haravan:checkorders:shop_domain:hangquoctai.myharavan.com',
      'org_1',
    );

    const result = await service.handleWebhook({
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'app/uninstalled',
      },
    } as unknown as Request & { rawBody: Buffer });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, orgid: 'org_1', uninstalled: true }),
    );
    expect(db.clearTokensForUninstall).toHaveBeenCalledWith('org_1');
    expect(storeService.deactivateStore).toHaveBeenCalledWith('org_1');
    expect(
      redis.get('haravan:checkorders:shop_domain:hangquoctai.myharavan.com'),
    ).toBeNull();
    expect(redis.get('haravan:checkorders:app_install:org_1')).toEqual(
      expect.objectContaining({
        orgid: 'org_1',
        status: 'uninstalled',
        plan: 'Pro',
        haravan_token_status: 'uninstalled',
      }),
    );
    expect(orderIndexService.purgeOrg).toHaveBeenCalledWith('org_1');
  });

  it('handles app uninstall webhook even when redis install session is absent', async () => {
    const { service, storeService, db } = createService();
    const body = {
      orgid: 'org_1',
      myharavan_domain: 'hangquoctai.myharavan.com',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');

    const result = await service.handleWebhook({
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'app/uninstalled',
      },
    } as unknown as Request & { rawBody: Buffer });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, orgid: 'org_1', uninstalled: true }),
    );
    expect(db.clearTokensForUninstall).toHaveBeenCalledWith('org_1');
    expect(storeService.deactivateStore).toHaveBeenCalledWith('org_1');
  });

  it('re-throws when clearTokensForUninstall fails to prevent false success', async () => {
    const { service, db } = createService();
    db.clearTokensForUninstall.mockRejectedValueOnce(
      new Error('DB connection dead'),
    );
    const body = {
      orgid: 'org_1',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');

    await expect(
      service.handleWebhook({
        rawBody,
        body,
        query: {},
        headers: {
          'x-haravan-hmacsha256': hmac,
          'x-haravan-topic': 'app/uninstalled',
        },
      } as unknown as Request & { rawBody: Buffer }),
    ).rejects.toThrow('DB connection dead');
  });
  it('handles shop update webhook and resyncs domain mapping', async () => {
    const { service, redis, storeService } = createService();
    const body = {
      orgid: 'org_1',
      domain: 'hangquoctai.com',
      primary_domain: 'hangquoctai.com',
      myharavan_domain: 'hangquoctai.myharavan.com',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');

    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
      status: 'active',
      primary_domain: 'old-domain.com',
      domain: 'old-domain.com',
      myharavan_domain: 'hangquoctai.myharavan.com',
    });

    const result = await service.handleWebhook({
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'shop/update',
      },
    } as unknown as Request & { rawBody: Buffer });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, orgid: 'org_1' }),
    );
    expect(storeService.registerStore).toHaveBeenCalled();
    expect(redis.get('haravan:checkorders:app_install:org_1')).toEqual(
      expect.objectContaining({
        orgid: 'org_1',
        domain: 'hangquoctai.com',
        primary_domain: 'hangquoctai.com',
        myharavan_domain: 'hangquoctai.myharavan.com',
      }),
    );
    expect(redis.get('haravan:checkorders:shop_domain:hangquoctai.com')).toBe(
      'org_1',
    );
    expect(
      redis.get('haravan:checkorders:shop_domain:hangquoctai.myharavan.com'),
    ).toBe('org_1');
  });

describe('HaravanService order webhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeWebhookReq = (topic: string, body: Record<string, unknown>) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');
    return {
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': topic,
        'x-haravan-org-id': 'org_test_1',
      },
    } as unknown as Request & { rawBody: Buffer };
  };

  it('upserts order index on orders/create and orders/updated', async () => {
    const { service, orderIndexService } = createService();
    const orderData = {
      id: 12345,
      order_number: 1001,
      name: '#1001',
      phone: '0901234567',
    };

    const reqCreate = makeWebhookReq('orders/create', { orgid: 'org_test_1', ...orderData });
    const resultCreate = await service.handleWebhook(reqCreate);

    expect(resultCreate).toEqual(
      expect.objectContaining({ ok: true, topic: 'orders/create', orgid: 'org_test_1' }),
    );
    expect(orderIndexService.upsertOrder).toHaveBeenCalledWith(
      'org_test_1',
      expect.objectContaining({ id: 12345 }),
    );

    const reqUpdate = makeWebhookReq('orders/updated', { orgid: 'org_test_1', order: orderData });
    const resultUpdate = await service.handleWebhook(reqUpdate);

    expect(resultUpdate).toEqual(
      expect.objectContaining({ ok: true, topic: 'orders/updated', orgid: 'org_test_1' }),
    );
    expect(orderIndexService.upsertOrder).toHaveBeenCalledWith(
      'org_test_1',
      expect.objectContaining({ id: 12345 }),
    );
  });

  it('deletes order index on orders/delete', async () => {
    const { service, orderIndexService } = createService();
    const reqDelete = makeWebhookReq('orders/delete', { orgid: 'org_test_1', id: 12345 });
    const result = await service.handleWebhook(reqDelete);

    expect(result).toEqual(
      expect.objectContaining({ ok: true, topic: 'orders/delete', orgid: 'org_test_1', deleted: true }),
    );
    expect(orderIndexService.deleteOrder).toHaveBeenCalledWith('org_test_1', '12345');
  });

  it('handles unknown order payload shape without throwing', async () => {
    const { service, orderIndexService } = createService();
    const reqMalformed = makeWebhookReq('orders/create', { orgid: 'org_test_1' });
    const result = await service.handleWebhook(reqMalformed);

    expect(result).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(orderIndexService.upsertOrder).not.toHaveBeenCalled();
  });

  it('invalidates order lookup cache and deduplicates identical webhook deliveries within TTL window', async () => {
    const { service, redis, orderIndexService } = createService();
    redis.set('haravan:checkorders:cache:org_test_1:abc:max5', {
      orders: [{ id: 99999 }],
    });
    const payload = {
      orgid: 'org_test_1',
      id: 99999,
      order_number: 9999,
      name: '#9999',
      phone: '0901234567',
    };

    const first = await service.handleWebhook(
      makeWebhookReq('orders/updated', payload),
    );
    const second = await service.handleWebhook(
      makeWebhookReq('orders/updated', payload),
    );

    expect(first).toEqual(expect.objectContaining({ ok: true, processed: true }));
    expect(second).toEqual(expect.objectContaining({ ok: true, duplicate: true }));
    expect(orderIndexService.upsertOrder).toHaveBeenCalledTimes(1);
    expect(redis.get('haravan:checkorders:cache:org_test_1:abc:max5')).toBeNull();
  });
});

describe('HaravanService webhook dedupe', () => {
  const DAY = 24 * 60 * 60;

  const makeReq = (topic: string, body: Record<string, unknown>) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');
    return {
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': topic,
        'x-haravan-org-id': 'org_test_1',
      },
    } as unknown as Request & { rawBody: Buffer };
  };

  const dedupeKeyOf = (redis: RedisMock): string => {
    const keys = redis
      .getKeys('haravan:checkorders:webhook_dedupe:')
      .filter((key) => key.includes('webhook_dedupe'));
    expect(keys).toHaveLength(1);
    return keys[0];
  };

  it('holds an order delivery for 7 days once it has been processed', async () => {
    const { service, redis } = createService();
    const setNx = jest.spyOn(redis, 'setNx');
    const set = jest.spyOn(redis, 'set');

    await service.handleWebhook(
      makeReq('orders/updated', { orgid: 'org_test_1', id: 1 }),
    );

    expect(setNx).toHaveBeenCalledWith(
      expect.stringContaining('webhook_dedupe:orders/updated:'),
      'processing',
      120,
    );
    expect(set).toHaveBeenCalledWith(
      expect.stringContaining('webhook_dedupe:orders/updated:'),
      'done',
      7 * DAY,
    );
  });

  it('accepts the singular order topic variants for the 7 day window', async () => {
    const { service, redis } = createService();
    const set = jest.spyOn(redis, 'set');

    await service.handleWebhook(
      makeReq('order/updated', { orgid: 'org_test_1', id: 1 }),
    );

    expect(set).toHaveBeenCalledWith(
      expect.stringContaining('webhook_dedupe:order/updated:'),
      'done',
      7 * DAY,
    );
  });

  it('keeps the 120 second window for non-order topics', async () => {
    const { service, redis } = createService();
    const set = jest.spyOn(redis, 'set');

    await service.handleWebhook(
      makeReq('app/uninstalled', { orgid: 'org_test_1' }),
    );
    await service.handleWebhook(
      makeReq('themes/publish', { orgid: 'org_test_1', id: 5 }),
    );

    const doneWrites = set.mock.calls.filter((call) => call[1] === 'done');
    expect(doneWrites).toHaveLength(2);
    for (const call of doneWrites) {
      expect(call[2]).toBe(120);
    }
  });

  it('releases the dedupe key when the handler fails so a retry is processed', async () => {
    const { service, redis, db } = createService();
    const req = makeReq('app/uninstalled', { orgid: 'org_test_1' });
    db.clearTokensForUninstall.mockRejectedValueOnce(new Error('db down'));

    await expect(service.handleWebhook(req)).rejects.toThrow('db down');
    expect(
      redis.getKeys('haravan:checkorders:webhook_dedupe:'),
    ).toHaveLength(0);

    const retry = await service.handleWebhook(req);
    expect(retry).toEqual(
      expect.objectContaining({ ok: true, uninstalled: true }),
    );
    expect(db.clearTokensForUninstall).toHaveBeenCalledTimes(2);
    expect(redis.get(dedupeKeyOf(redis))).toBe('done');
  });

  it('answers 503 while the first delivery is still processing so Haravan retries', async () => {
    const { service, redis, orderIndexService } = createService();
    const req = makeReq('orders/delete', { orgid: 'org_test_1', id: 43 });
    let release: () => void = () => undefined;
    orderIndexService.deleteOrder.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const first = service.handleWebhook(req);
    await new Promise((resolve) => setImmediate(resolve));
    expect(redis.get(dedupeKeyOf(redis))).toBe('processing');
    await expect(service.handleWebhook(req)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    release();
    await first;

    expect(orderIndexService.deleteOrder).toHaveBeenCalledTimes(1);
    expect(redis.get(dedupeKeyOf(redis))).toBe('done');
  });

  it('answers a 200 duplicate once the first delivery is done', async () => {
    const { service, orderIndexService } = createService();
    const req = makeReq('orders/delete', { orgid: 'org_test_1', id: 44 });

    await service.handleWebhook(req);
    const second = await service.handleWebhook(req);

    expect(second).toEqual(expect.objectContaining({ duplicate: true }));
    expect(orderIndexService.deleteOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps the 200 duplicate answer when the marker cannot be read', async () => {
    const { service, redis } = createService();
    const req = makeReq('orders/delete', { orgid: 'org_test_1', id: 45 });
    await service.handleWebhook(req);
    redis.set(dedupeKeyOf(redis), 'processing');
    jest.spyOn(redis, 'setNx').mockReturnValue(false);
    const get = redis.get.bind(redis);
    jest.spyOn(redis, 'get').mockImplementation((key: string) => {
      if (key === dedupeKeyOf(redis)) throw new Error('redis down');
      return get(key);
    });

    await expect(service.handleWebhook(req)).resolves.toEqual(
      expect.objectContaining({ duplicate: true }),
    );
  });

  it('does not fail the webhook when marking the key done fails', async () => {
    const { service, redis } = createService();
    const req = makeReq('orders/delete', { orgid: 'org_test_1', id: 46 });
    const set = redis.set.bind(redis);
    jest.spyOn(redis, 'set').mockImplementation((key, value, ttl) => {
      if (value === 'done') throw new Error('redis down');
      set(key, value, ttl);
    });

    await expect(service.handleWebhook(req)).resolves.toEqual(
      expect.objectContaining({ ok: true, deleted: true }),
    );
  });
});

describe('HaravanService webhook org consistency', () => {
  const build = (
    body: Record<string, unknown>,
    opts: { header?: string; query?: Record<string, string> } = {},
  ) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');
    return {
      rawBody,
      body,
      query: opts.query || {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'orders/create',
        ...(opts.header ? { 'x-haravan-org-id': opts.header } : {}),
      },
    } as unknown as Request & { rawBody: Buffer };
  };

  it.each([
    ['query orgid', {}, { query: { orgid: 'org_B' } }],
    ['query org_id', {}, { query: { org_id: 'org_B' } }],
    ['body orgid', { orgid: 'org_B' }, {}],
    ['body org_id', { org_id: 'org_B' }, {}],
    ['body organization_id', { organization_id: 'org_B' }, {}],
  ])('rejects a header org that disagrees with %s before any processing', async (_, extraBody, opts) => {
    const { service, redis, orderIndexService, db } = createService();
    const body = { id: 5, name: '#5', ...extraBody };

    await expect(
      service.handleWebhook(build(body, { header: 'org_A', ...opts })),
    ).rejects.toThrow('Org id mismatch');

    expect(orderIndexService.upsertOrder).not.toHaveBeenCalled();
    expect(db.recordWebhook).not.toHaveBeenCalled();
    expect(redis.getKeys('haravan:checkorders:webhook_dedupe:')).toHaveLength(0);
  });

  it('rejects disagreeing query and body orgs even without a header', async () => {
    const { service } = createService();
    await expect(
      service.handleWebhook(
        build({ id: 5, orgid: 'org_B' }, { query: { orgid: 'org_A' } }),
      ),
    ).rejects.toThrow('Org id mismatch');
  });

  it('processes with the header org when it is the only source', async () => {
    const { service, orderIndexService } = createService();
    await expect(
      service.handleWebhook(build({ id: 5, name: '#5' }, { header: 'org_A' })),
    ).resolves.toEqual(expect.objectContaining({ ok: true, orgid: 'org_A' }));
    expect(orderIndexService.upsertOrder).toHaveBeenCalledWith(
      'org_A',
      expect.objectContaining({ id: 5 }),
    );
  });

  it('accepts matching sources even when a value is whitespace padded', async () => {
    const { service } = createService();
    await expect(
      service.handleWebhook(
        build(
          { id: 6, orgid: ' org_A ' },
          { header: 'org_A', query: { orgid: 'org_A' } },
        ),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, orgid: 'org_A' }));
  });

  it('does not compare shop_id or shop.id with the header', async () => {
    const { service } = createService();
    await expect(
      service.handleWebhook(
        build(
          { id: 7, shop_id: 'shop_999', shop: { id: 'shop_998' } },
          { header: 'org_A' },
        ),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, orgid: 'org_A' }));
  });
});

describe('HaravanService session revocation', () => {
  const NOW = () => Math.floor(Date.now() / 1000);
  const KEY = 'haravan:checkorders:session_revoked_before:org_1';
  const session = (iat: number) => ({
    orgid: 'org_1',
    type: 'haravan_app_session' as const,
    iat,
    exp: iat + 3600,
  });
  const uninstallReq = () => {
    const body = { orgid: 'org_1' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = crypto
      .createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('base64');
    return {
      rawBody,
      body,
      query: {},
      headers: {
        'x-haravan-hmacsha256': hmac,
        'x-haravan-topic': 'app/uninstalled',
        'x-haravan-org-id': 'org_1',
      },
    } as unknown as Request & { rawBody: Buffer };
  };

  it('app/uninstalled records the revocation marker before clearing tokens', async () => {
    const { service, redis, db } = createService();
    const order: string[] = [];
    const set = redis.set.bind(redis);
    jest.spyOn(redis, 'set').mockImplementation((key, value, ttl) => {
      if (key === KEY) order.push('marker');
      set(key, value, ttl);
    });
    db.clearTokensForUninstall.mockImplementation(() => {
      order.push('clear');
      return Promise.resolve();
    });

    await service.handleWebhook(uninstallReq());

    expect(order.slice(0, 2)).toEqual(['marker', 'clear']);
    expect(redis.get<number>(KEY)).toBeGreaterThan(NOW() - 5);
  });

  it('app/uninstalled still revokes when clearing tokens fails', async () => {
    const { service, redis, db } = createService();
    db.clearTokensForUninstall.mockRejectedValueOnce(new Error('db down'));

    await expect(service.handleWebhook(uninstallReq())).rejects.toThrow(
      'db down',
    );

    expect(redis.get<number>(KEY)).toBeGreaterThan(0);
  });

  it('rejects a session issued before the uninstall and accepts a later one', async () => {
    const { service, redis } = createService();
    redis.set(KEY, NOW());

    await expect(
      service.assertSessionNotRevoked(session(NOW() - 60)),
    ).rejects.toThrow('Auth session revoked');
    await expect(
      service.assertSessionNotRevoked(session(NOW())),
    ).resolves.toBeUndefined();
    await expect(
      service.assertSessionNotRevoked(session(NOW() + 10)),
    ).resolves.toBeUndefined();
  });

  it('accepts any session when no marker exists', async () => {
    const { service } = createService();
    await expect(
      service.assertSessionNotRevoked(session(1)),
    ).resolves.toBeUndefined();
  });

  it('resolveAdminSessionToken refuses a revoked session', async () => {
    const { service, redis } = createService();
    const token = (
      service as unknown as { createSessionToken(orgid: string): string }
    ).createSessionToken('org_1');
    redis.set(KEY, NOW() + 60);

    await expect(
      service.resolveAdminSessionToken(token, 'org_1'),
    ).rejects.toThrow('Auth session revoked');
  });
});

describe('HaravanService launch HMAC and challenge', () => {
  const sign = (query: string) =>
    crypto.createHmac('sha256', 'client-secret').update(query).digest('hex');
  const signed = (query: string) => `${query}&hmac=${sign(query)}`;
  const NOW = () => Math.floor(Date.now() / 1000);

  const seedInstall = (redis: RedisMock) =>
    redis.set('haravan:checkorders:app_install:org_1', {
      orgid: 'org_1',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      status: 'active',
      token_expires_at: Date.now() + 60 * 60 * 1000,
    });

  it.each([
    ['missing', 'orgid=org_1', 'Timestamp missing'],
    ['empty', 'orgid=org_1&timestamp=', 'Timestamp missing'],
    ['non-numeric', 'orgid=org_1&timestamp=abc', 'Timestamp invalid'],
    ['negative', 'orgid=org_1&timestamp=-1', 'Timestamp invalid'],
    ['trailing garbage', 'orgid=org_1&timestamp=12abc', 'Timestamp invalid'],
    ['stale', `orgid=org_1&timestamp=${NOW() - 3600}`, 'Timestamp expired'],
    ['future', `orgid=org_1&timestamp=${NOW() + 3600}`, 'Timestamp expired'],
  ])('rejects a correctly signed launch with a %s timestamp', async (_, query, reason) => {
    const { service, redis } = createService();
    seedInstall(redis);

    await expect(service.verifyHmac(signed(query))).resolves.toEqual({
      valid: false,
      reason,
    });
  });

  it('accepts a correctly signed launch with a fresh numeric timestamp', async () => {
    const { service, redis } = createService();
    seedInstall(redis);

    const result = await service.verifyHmac(
      signed(`orgid=org_1&timestamp=${NOW()}`),
    );

    expect(result).toEqual(
      expect.objectContaining({ valid: true, orgid: 'org_1' }),
    );
    expect(
      redis.get('haravan:checkorders:session_revoked_before:org_1'),
    ).toBeNull();
  });

  it('checks the signature before the timestamp', async () => {
    const { service } = createService();
    const result = await service.verifyHmac(
      `orgid=org_1&timestamp=1&hmac=${'a'.repeat(64)}`,
    );
    expect(result).toEqual({ valid: false, reason: 'HMAC mismatch' });
  });

  it('verifyWebhookChallenge accepts the configured token only', () => {
    const { service } = createService();
    const challenge = (token: string) =>
      service.verifyWebhookChallenge({
        'hub.verify_token': token,
        'hub.challenge': 'echo-me',
      });

    expect(challenge('webhook-secret')).toBe('echo-me');
    expect(() => challenge('webhook-secre')).toThrow('Invalid webhook challenge');
    expect(() => challenge('webhook-secreX')).toThrow(
      'Invalid webhook challenge',
    );
    expect(() => challenge('webhook-secret-longer')).toThrow(
      'Invalid webhook challenge',
    );
    expect(() =>
      service.verifyWebhookChallenge({ 'hub.challenge': 'echo-me' }),
    ).toThrow('Invalid webhook challenge');
  });
});

describe('HaravanService production secrets', () => {
  const build = (env: Record<string, string>) => {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    return new HaravanService(
      config,
      new RedisMock() as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  };
  const sessionToken = (service: HaravanService) =>
    (
      service as unknown as { createSessionToken(orgid: string): string }
    ).createSessionToken('org_1');

  it('refuses the Haravan client secret as the session secret in production', () => {
    const service = build({ NODE_ENV: 'production', HRV_CLIENT_SECRET: 'client-secret' });
    expect(() => sessionToken(service)).toThrow('Session secret missing');
  });

  it('signs sessions with APP_SESSION_SECRET in production', () => {
    const service = build({
      NODE_ENV: 'production',
      HRV_CLIENT_SECRET: 'client-secret',
      APP_SESSION_SECRET: 'session-secret',
    });
    expect(service.verifySessionToken(sessionToken(service)).orgid).toBe(
      'org_1',
    );
  });

  it('keeps the client secret fallback outside production', () => {
    const service = build({ NODE_ENV: 'test', HRV_CLIENT_SECRET: 'client-secret' });
    expect(service.verifySessionToken(sessionToken(service)).orgid).toBe(
      'org_1',
    );
  });
});
});
