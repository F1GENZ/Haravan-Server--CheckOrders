export const PREMIUM_EXPIRES_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function isPremiumOrg(orgid: string | undefined | null): boolean {
  const id = String(orgid || '').trim();
  if (!id) return false;
  return String(process.env.PREMIUM_ORGIDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(id);
}
