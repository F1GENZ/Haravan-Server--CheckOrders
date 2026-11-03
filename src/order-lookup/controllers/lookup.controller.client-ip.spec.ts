import type { Request } from 'express';
import type { LookupRequestDto } from '../dto/lookup-request.dto';
import type { LookupService } from '../services/lookup.service';
import type { StoreService } from '../services/store.service';
import { LookupController } from './lookup.controller';

const lookupFrom = async (headers: Record<string, string>) => {
  const lookup = jest.fn().mockResolvedValue({ success: true });
  const controller = new LookupController({ lookup } as unknown as LookupService, {} as StoreService);
  const req = { ip: '::1', socket: { remoteAddress: '::1' }, headers } as unknown as Request;
  await controller.lookup({ shop: 'demo', phone: '0901234567' } as LookupRequestDto, '', '', '', req);
  return lookup.mock.calls[0][3] as string;
};

describe('LookupController client ip', () => {
  const original = process.env.TRUST_CF_CONNECTING_IP;
  const originalSecret = process.env.PAGES_PROXY_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
    else process.env.TRUST_CF_CONNECTING_IP = original;
    if (originalSecret === undefined) delete process.env.PAGES_PROXY_SECRET;
    else process.env.PAGES_PROXY_SECRET = originalSecret;
  });

  it('ignores CF-Connecting-IP by default, so a caller cannot pick its own rate-limit bucket', async () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(await lookupFrom({ 'cf-connecting-ip': '203.0.113.9' })).toBe('::1');
  });

  it('uses CF-Connecting-IP when the operator opts in, and falls back to the socket address without it', async () => {
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    expect(await lookupFrom({ 'cf-connecting-ip': '203.0.113.9' })).toBe('203.0.113.9');
    expect(await lookupFrom({})).toBe('::1');
  });

  it('uses the shopper address the Pages proxy forwards only when the proxy secret matches', async () => {
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    process.env.PAGES_PROXY_SECRET = 'proxy-secret-for-tests';
    const relayed = { 'cf-connecting-ip': '2a06:98c0:3600::103', 'x-forwarded-for': '198.51.100.7' };
    expect(await lookupFrom({ ...relayed, 'x-pages-proxy-auth': 'proxy-secret-for-tests' })).toBe('198.51.100.7');
    expect(await lookupFrom({ ...relayed, 'x-pages-proxy-auth': 'proxy-secret-for-test' })).toBe('2a06:98c0:3600::103');
    expect(await lookupFrom(relayed)).toBe('2a06:98c0:3600::103');
  });

  it('ignores the proxy header when no secret is configured or Cloudflare is not trusted', async () => {
    delete process.env.PAGES_PROXY_SECRET;
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    expect(await lookupFrom({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7', 'x-pages-proxy-auth': '' })).toBe('203.0.113.9');
    process.env.PAGES_PROXY_SECRET = 'proxy-secret-for-tests';
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(await lookupFrom({ 'x-forwarded-for': '198.51.100.7', 'x-pages-proxy-auth': 'proxy-secret-for-tests' })).toBe('::1');
  });
});
