import type { ConfigService } from '@nestjs/config';
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
});
