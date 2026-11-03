import type { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../database/prisma.service';
import {
  ENVELOPE_PREFIX,
  isSealed,
  open,
  resolveEnvelopeKey,
  seal,
} from './secret-envelope';

const HEX_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');
const PASSPHRASE = 'a passphrase that is not 32 bytes of base64';

const prismaWith = (key: string): PrismaService =>
  new PrismaService({
    get: (name: string) => (name === 'DATA_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as ConfigService);

describe('secret envelope', () => {
  it('round-trips a value', () => {
    const key = resolveEnvelopeKey(HEX_KEY);
    const sealed = seal(key!, 'refresh-token-value');
    expect(sealed.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(sealed).not.toContain('refresh-token-value');
    expect(open(key, sealed)).toBe('refresh-token-value');
  });

  it('uses a fresh iv for every seal', () => {
    const key = resolveEnvelopeKey(HEX_KEY)!;
    expect(seal(key, 'same')).not.toBe(seal(key, 'same'));
  });

  it.each([
    ['hex', HEX_KEY],
    ['base64', BASE64_KEY],
    ['passphrase', PASSPHRASE],
  ])('derives the same key bytes as PrismaService for a %s key', (_, raw) => {
    const prisma = prismaWith(raw);
    const encrypted = prisma.encrypt('payload')!;
    const envelope = `${ENVELOPE_PREFIX}${encrypted.iv}.${encrypted.tag}.${encrypted.ciphertext}`;
    expect(open(resolveEnvelopeKey(raw), envelope)).toBe('payload');
  });

  it('produces envelopes PrismaService can open after splitting on dots', () => {
    const raw = HEX_KEY;
    const sealed = seal(resolveEnvelopeKey(raw)!, 'from-envelope');
    const [iv, tag, ciphertext] = sealed
      .slice(ENVELOPE_PREFIX.length)
      .split('.');
    expect(prismaWith(raw).decryptParts(ciphertext, iv, tag)).toBe(
      'from-envelope',
    );
  });

  it('returns null for a wrong key, no key, tampering and malformed input', () => {
    const key = resolveEnvelopeKey(HEX_KEY)!;
    const sealed = seal(key, 'secret');
    const [iv, tag, ct] = sealed.slice(ENVELOPE_PREFIX.length).split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;

    expect(open(resolveEnvelopeKey(BASE64_KEY), sealed)).toBeNull();
    expect(open(null, sealed)).toBeNull();
    expect(
      open(key, `${ENVELOPE_PREFIX}${iv}.${tag}.${flipped.toString('base64')}`),
    ).toBeNull();
    expect(open(key, `${ENVELOPE_PREFIX}${iv}.${tag}`)).toBeNull();
    expect(open(key, `${ENVELOPE_PREFIX}${iv}..${ct}`)).toBeNull();
    expect(open(key, `${ENVELOPE_PREFIX}${iv}.${tag}.${ct}.extra`)).toBeNull();
    expect(open(key, 'plain-token')).toBeNull();
  });

  it('recognises only prefixed strings as sealed', () => {
    expect(isSealed('enc:v1:a.b.c')).toBe(true);
    expect(isSealed('plain')).toBe(false);
    expect(isSealed(undefined)).toBe(false);
    expect(isSealed(42)).toBe(false);
  });

  it('has no key for an empty or blank value', () => {
    expect(resolveEnvelopeKey(undefined)).toBeNull();
    expect(resolveEnvelopeKey('   ')).toBeNull();
    expect(resolveEnvelopeKey(HEX_KEY)).toEqual(Buffer.from(HEX_KEY, 'hex'));
    expect(resolveEnvelopeKey(PASSPHRASE)).toEqual(
      crypto.createHash('sha256').update(PASSPHRASE).digest(),
    );
  });
});
