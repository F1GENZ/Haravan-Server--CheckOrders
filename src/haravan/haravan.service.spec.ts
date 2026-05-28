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
    const service = new HaravanService(
      makeConfig(),
      redis as never,
      { getShop: jest.fn() } as never,
      {
        getStoreByDomain: jest.fn(),
        getStoreByOrgId: jest.fn(),
        registerStore: jest.fn(),
      } as never,
    );
    return { service, redis };
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
    expect(redis.get('haravan:checkorders:shop_domain:shop.myharavan.com')).toBe(
      'org_1',
    );
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
    } as Request & { rawBody: Buffer });

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

  it('rejects install callback without OAuth state', async () => {
    const { service } = createService();
    const res = createResponse();

    await service.installApp('oauth-code', undefined, res as Response);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=install_failed'),
    );
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});
