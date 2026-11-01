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
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
    else process.env.TRUST_CF_CONNECTING_IP = original;
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
});
