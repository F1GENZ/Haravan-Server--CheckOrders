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
});
