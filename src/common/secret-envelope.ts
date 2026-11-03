import * as crypto from 'crypto';

/**
 * Self-describing AES-256-GCM envelope: `enc:v1:<iv_b64>.<tag_b64>.<ct_b64>`.
 * Key derivation and cipher parameters match PrismaService.encrypt so the
 * same DATA_ENCRYPTION_KEY opens both representations.
 */
export const ENVELOPE_PREFIX = 'enc:v1:';

export function resolveEnvelopeKey(raw?: string | null): Buffer | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 32) return decoded;
  return crypto.createHash('sha256').update(value).digest();
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

export function seal(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${ENVELOPE_PREFIX}${iv.toString('base64')}.${cipher
    .getAuthTag()
    .toString('base64')}.${ct.toString('base64')}`;
}

/** Never throws and never returns the sealed string; null means unreadable. */
export function open(key: Buffer | null, sealed: string): string | null {
  if (!key || !isSealed(sealed)) return null;
  const parts = sealed.slice(ENVELOPE_PREFIX.length).split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[0], 'base64'),
    );
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
