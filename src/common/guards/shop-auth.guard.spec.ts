import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { ShopAuthGuard } from './shop-auth.guard';
import type { HaravanService } from '../../haravan/haravan.service';

const createContext = (request: Record<string, unknown>): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  }) as ExecutionContext;

describe('ShopAuthGuard', () => {
  it('accepts auth_session_token from cookie when bearer token is absent', async () => {
    const haravanServiceMock = {
      verifySessionToken: jest.fn(() => ({
        orgid: 'org_1',
        type: 'haravan_app_session',
        exp: Math.floor(Date.now() / 1000) + 300,
      })),
      assertSessionNotRevoked: jest.fn().mockResolvedValue(undefined),
      resolveAccessToken: jest.fn().mockResolvedValue('access-token'),
    };
    const guard = new ShopAuthGuard(
      haravanServiceMock as unknown as HaravanService,
    );
    const request = {
      method: 'GET',
      headers: {
        cookie: `auth_session_token=${encodeURIComponent('session-token')}`,
      },
      query: { orgid: 'org_1' },
      body: {},
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(haravanServiceMock.verifySessionToken).toHaveBeenCalledWith(
      'session-token',
    );
    expect(haravanServiceMock.resolveAccessToken).toHaveBeenCalledWith('org_1');
    expect(request).toEqual(
      expect.objectContaining({
        orgid: 'org_1',
        token: 'access-token',
      }),
    );
  });

  it('rejects mismatched orgid even with a valid session cookie', async () => {
    const haravanServiceMock = {
      verifySessionToken: jest.fn(() => ({
        orgid: 'org_1',
        type: 'haravan_app_session',
        exp: Math.floor(Date.now() / 1000) + 300,
      })),
      assertSessionNotRevoked: jest.fn(),
      resolveAccessToken: jest.fn(),
    };
    const guard = new ShopAuthGuard(
      haravanServiceMock as unknown as HaravanService,
    );

    await expect(
      guard.canActivate(
        createContext({
          method: 'GET',
          headers: {
            cookie: `auth_session_token=${encodeURIComponent('session-token')}`,
          },
          query: { orgid: 'org_2' },
          body: {},
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(haravanServiceMock.resolveAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a revoked session before resolving the Haravan token', async () => {
    const haravanServiceMock = {
      verifySessionToken: jest.fn(() => ({
        orgid: 'org_1',
        type: 'haravan_app_session',
        iat: 100,
        exp: Math.floor(Date.now() / 1000) + 300,
      })),
      assertSessionNotRevoked: jest
        .fn()
        .mockRejectedValue(new UnauthorizedException('Auth session revoked')),
      resolveAccessToken: jest.fn(),
    };
    const guard = new ShopAuthGuard(
      haravanServiceMock as unknown as HaravanService,
    );

    await expect(
      guard.canActivate(
        createContext({
          method: 'GET',
          headers: {
            cookie: `auth_session_token=${encodeURIComponent('session-token')}`,
          },
          query: { orgid: 'org_1' },
          body: {},
        }),
      ),
    ).rejects.toThrow('Auth session revoked');
    expect(haravanServiceMock.assertSessionNotRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ orgid: 'org_1', iat: 100 }),
    );
    expect(haravanServiceMock.resolveAccessToken).not.toHaveBeenCalled();
  });

  describe('forwarded host trust on state-changing requests', () => {
    const envKeys = ['FRONTEND_URL', 'API_BASE_URL', 'WIDGET_PUBLIC_URL', 'WIDGET_API_URL', 'CORS_ALLOWED_ORIGINS'];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of envKeys) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      process.env.FRONTEND_URL = 'https://app.example.test';
    });

    afterEach(() => {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    const createGuard = () => {
      const haravanServiceMock = {
        verifySessionToken: jest.fn(() => ({
          orgid: 'org_1',
          type: 'haravan_app_session',
          exp: Math.floor(Date.now() / 1000) + 300,
        })),
        assertSessionNotRevoked: jest.fn().mockResolvedValue(undefined),
        resolveAccessToken: jest.fn().mockResolvedValue('access-token'),
      };
      return new ShopAuthGuard(haravanServiceMock as unknown as HaravanService);
    };

    const putRequest = (origin: string, forwardedHost: string) => ({
      method: 'PUT',
      headers: {
        host: 'api.internal.test',
        origin,
        'x-forwarded-host': forwardedHost,
        cookie: `auth_session_token=${encodeURIComponent('session-token')}`,
      },
      query: { orgid: 'org_1' },
      body: {},
    });

    it('rejects an attacker-controlled X-Forwarded-Host that matches the Origin', async () => {
      await expect(
        createGuard().canActivate(
          createContext(putRequest('https://evil.example', 'evil.example')),
        ),
      ).rejects.toThrow('Untrusted request origin');
    });

    it('accepts the first X-Forwarded-Host value when it is a configured host', async () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://pages.example.test';
      await expect(
        createGuard().canActivate(
          createContext(
            putRequest(
              'https://pages.example.test',
              'pages.example.test, evil.example',
            ),
          ),
        ),
      ).resolves.toBe(true);
    });

    it('does not trust a configured host that is not the first forwarded value', async () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://pages.example.test';
      await expect(
        createGuard().canActivate(
          createContext(
            putRequest(
              'https://pages.example.test',
              'evil.example, pages.example.test',
            ),
          ),
        ),
      ).rejects.toThrow('Untrusted request origin');
    });
  });
});
