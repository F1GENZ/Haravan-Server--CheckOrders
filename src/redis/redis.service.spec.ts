import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  ENVELOPE_PREFIX,
  resolveEnvelopeKey,
  seal,
} from '../common/secret-envelope';
import { RedisService, SEAL_REDIS_TOKENS_ON_WRITE } from './redis.service';

const RAW_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY = resolveEnvelopeKey(RAW_KEY)!;

class FakeClient {
  readonly data = new Map<string, string>();
  get = jest.fn((key: string) => Promise.resolve(this.data.get(key) ?? null));
  set = jest.fn((key: string, value: string) => {
    this.data.set(key, value);
    return Promise.resolve('OK');
  });
}

const config = (value?: string): ConfigService =>
  ({
    get: (name: string) => (name === 'DATA_ENCRYPTION_KEY' ? value : undefined),
  }) as unknown as ConfigService;

const build = (rawKey: string | undefined, sealOnWrite?: boolean) => {
  const client = new FakeClient();
  const service = new RedisService(client as unknown as Redis, config(rawKey));
  if (sealOnWrite !== undefined) {
    (service as unknown as { sealOnWrite: boolean }).sealOnWrite = sealOnWrite;
  }
  return { client, service };
};

describe('RedisService token reader', () => {
  it('passes plaintext records through unchanged', async () => {
    const { client, service } = build(RAW_KEY);
    client.data.set(
      'k',
      JSON.stringify({
        access_token: 'plain-a',
        refresh_token: 'plain-r',
        status: 'active',
      }),
    );
    await expect(service.get('k')).resolves.toEqual({
      access_token: 'plain-a',
      refresh_token: 'plain-r',
      status: 'active',
    });
  });

  it('decodes sealed access and refresh tokens', async () => {
    const { client, service } = build(RAW_KEY);
    client.data.set(
      'k',
      JSON.stringify({
        access_token: seal(KEY, 'real-access'),
        refresh_token: seal(KEY, 'real-refresh'),
        orgid: 'org_1',
      }),
    );
    await expect(service.get('k')).resolves.toEqual({
      access_token: 'real-access',
      refresh_token: 'real-refresh',
      orgid: 'org_1',
    });
  });

  it('decodes a record that mixes sealed and plaintext token fields', async () => {
    const { client, service } = build(RAW_KEY);
    client.data.set(
      'k',
      JSON.stringify({
        access_token: seal(KEY, 'real-access'),
        refresh_token: 'plain-r',
      }),
    );
    await expect(service.get('k')).resolves.toEqual({
      access_token: 'real-access',
      refresh_token: 'plain-r',
    });
  });

  it.each([
    ['a different key', resolveEnvelopeKey('another key entirely')!, RAW_KEY],
    ['no key configured', KEY, undefined],
  ])(
    'returns null, never ciphertext or an empty token, with %s',
    async (_, sealKey, readKey) => {
      const { client, service } = build(readKey);
      client.data.set(
        'k',
        JSON.stringify({
          access_token: seal(sealKey, 'secret'),
          refresh_token: 'plain-r',
        }),
      );
      const result = await service.get('k');
      expect(result).toBeNull();
    },
  );

  it('returns null for a tampered sealed token', async () => {
    const { client, service } = build(RAW_KEY);
    const sealed = seal(KEY, 'secret');
    client.data.set(
      'k',
      JSON.stringify({ access_token: `${sealed.slice(0, -2)}AA` }),
    );
    await expect(service.get('k')).resolves.toBeNull();
  });

  it('leaves non-token fields and non-object values untouched', async () => {
    const { client, service } = build(RAW_KEY);
    client.data.set(
      'a',
      JSON.stringify({ note: `${ENVELOPE_PREFIX}not-a-token-field` }),
    );
    client.data.set('b', JSON.stringify([1, 2]));
    client.data.set('c', JSON.stringify(`${ENVELOPE_PREFIX}whole-value`));
    await expect(service.get('a')).resolves.toEqual({
      note: `${ENVELOPE_PREFIX}not-a-token-field`,
    });
    await expect(service.get('b')).resolves.toEqual([1, 2]);
    await expect(service.get('c')).resolves.toBe(
      `${ENVELOPE_PREFIX}whole-value`,
    );
  });

  it('returns null for missing or unparsable values', async () => {
    const { client, service } = build(RAW_KEY);
    client.data.set('bad', '{not json');
    await expect(service.get('missing')).resolves.toBeNull();
    await expect(service.get('bad')).resolves.toBeNull();
  });
});

describe('RedisService token writer', () => {
  it('ships with the token writer switched off', () => {
    expect(SEAL_REDIS_TOKENS_ON_WRITE).toBe(false);
  });

  it('seals both token fields when sealing is switched on', async () => {
    const { client, service } = build(RAW_KEY, true);
    await service.set(
      'k',
      {
        access_token: 'real-access',
        refresh_token: 'real-refresh',
        orgid: 'org_1',
      },
      60,
    );

    const stored = JSON.parse(client.data.get('k')!) as Record<string, string>;
    expect(stored.access_token.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(stored.refresh_token.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(stored.orgid).toBe('org_1');
    expect(client.data.get('k')).not.toContain('real-access');
    expect(client.set).toHaveBeenCalledWith('k', expect.any(String), 'EX', 60);
    await expect(service.get('k')).resolves.toEqual({
      access_token: 'real-access',
      refresh_token: 'real-refresh',
      orgid: 'org_1',
    });
  });

  it('does not touch empty, non-string or already sealed tokens', async () => {
    const { client, service } = build(RAW_KEY, true);
    const already = seal(KEY, 'sealed-before');
    await service.set('k', {
      access_token: '',
      refresh_token: already,
      other: 5,
    });
    await service.set('n', { access_token: 12345 });

    const stored = JSON.parse(client.data.get('k')!) as Record<string, unknown>;
    expect(stored).toEqual({
      access_token: '',
      refresh_token: already,
      other: 5,
    });
    expect(JSON.parse(client.data.get('n')!)).toEqual({ access_token: 12345 });
  });

  it('writes plaintext when no key is configured', async () => {
    const { client, service } = build(undefined, true);
    await service.set('k', { access_token: 'plain' });
    expect(JSON.parse(client.data.get('k')!)).toEqual({
      access_token: 'plain',
    });
  });

  it('does not mutate the caller object', async () => {
    const { service } = build(RAW_KEY, true);
    const record = {
      access_token: 'real-access',
      refresh_token: 'real-refresh',
    };
    await service.set('k', record);
    expect(record).toEqual({
      access_token: 'real-access',
      refresh_token: 'real-refresh',
    });
  });

  it('migrates a plaintext record to ciphertext on the next write', async () => {
    const { client, service } = build(RAW_KEY, true);
    client.data.set(
      'k',
      JSON.stringify({ access_token: 'plain-a', refresh_token: 'plain-r' }),
    );

    const record = await service.get<Record<string, string>>('k');
    await service.set('k', { ...record, status: 'active' });

    const stored = JSON.parse(client.data.get('k')!) as Record<string, string>;
    expect(stored.access_token.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(stored.refresh_token.startsWith(ENVELOPE_PREFIX)).toBe(true);
    await expect(service.get('k')).resolves.toEqual({
      access_token: 'plain-a',
      refresh_token: 'plain-r',
      status: 'active',
    });
  });

  it('writes plaintext when sealing is explicitly switched off', async () => {
    const { client, service } = build(RAW_KEY, false);
    await service.set('k', { access_token: 'plain' });
    expect(JSON.parse(client.data.get('k')!)).toEqual({
      access_token: 'plain',
    });
  });

  it('seals through the default switch exactly when the constant is on', async () => {
    const { client, service } = build(RAW_KEY);
    await service.set('k', { access_token: 'plain' });
    const stored = JSON.parse(client.data.get('k')!) as Record<string, string>;
    expect(stored.access_token.startsWith(ENVELOPE_PREFIX)).toBe(
      SEAL_REDIS_TOKENS_ON_WRITE,
    );
  });
});
