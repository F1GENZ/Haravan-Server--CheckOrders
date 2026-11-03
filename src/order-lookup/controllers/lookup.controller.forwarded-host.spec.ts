import type { Request } from 'express';
import type { LookupRequestDto } from '../dto/lookup-request.dto';
import type { LookupService } from '../services/lookup.service';
import type { StoreService } from '../services/store.service';
import { LookupController } from './lookup.controller';

const ENV_KEYS = [
  'FRONTEND_URL',
  'API_BASE_URL',
  'WIDGET_PUBLIC_URL',
  'WIDGET_API_URL',
  'CORS_ALLOWED_ORIGINS',
];

const proxyHostSeenBy = async (headers: Record<string, string>) => {
  const lookup = jest.fn().mockResolvedValue({ success: true });
  const controller = new LookupController(
    { lookup } as unknown as LookupService,
    {} as StoreService,
  );
  const req = {
    ip: '::1',
    socket: { remoteAddress: '::1' },
    headers,
  } as unknown as Request;
  await controller.lookup(
    { shop: 'demo', phone: '0901234567' } as LookupRequestDto,
    '',
    '',
    '',
    req,
  );
  return lookup.mock.calls[0][7] as string | undefined;
};

describe('LookupController forwarded host', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.FRONTEND_URL = 'https://admin.example.test';
    process.env.CORS_ALLOWED_ORIGINS = 'https://pages.example.test';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('ignores an untrusted X-Forwarded-Host and uses the Host header', async () => {
    expect(
      await proxyHostSeenBy({
        host: 'api.internal.test',
        'x-forwarded-host': 'evil.example',
      }),
    ).toBe('api.internal.test');
  });

  it('uses a configured forwarded host', async () => {
    expect(
      await proxyHostSeenBy({
        host: 'api.internal.test',
        'x-forwarded-host': 'pages.example.test',
      }),
    ).toBe('pages.example.test');
  });

  it('only checks the first value of a comma list', async () => {
    expect(
      await proxyHostSeenBy({
        host: 'api.internal.test',
        'x-forwarded-host': 'evil.example, pages.example.test',
      }),
    ).toBe('api.internal.test');
  });

  it('returns undefined when neither header is present', async () => {
    expect(await proxyHostSeenBy({})).toBeUndefined();
  });
});
