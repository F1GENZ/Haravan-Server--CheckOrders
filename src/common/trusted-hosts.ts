type EnvLike = Record<string, string | undefined>;

const hostOf = (value: string | undefined): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Hostnames this deployment legitimately serves under. A client-supplied
 * X-Forwarded-Host is only believed when it is one of these.
 */
export function getTrustedHostSet(env: EnvLike = process.env): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const host = hostOf(value);
    if (host) hosts.add(host);
  };
  add(env.FRONTEND_URL);
  add(env.API_BASE_URL);
  add(env.WIDGET_PUBLIC_URL);
  add(env.WIDGET_API_URL);
  for (const origin of String(env.CORS_ALLOWED_ORIGINS || '').split(',')) {
    add(origin);
  }
  return hosts;
}

const normalizeHost = (first: string): string | null => {
  try {
    return new URL(
      /^https?:\/\//i.test(first) ? first : `https://${first}`,
    ).hostname.toLowerCase();
  } catch {
    return first.split(':')[0]?.toLowerCase() || null;
  }
};

/** First X-Forwarded-Host hostname, or null unless it is a trusted host. */
export function resolveTrustedForwardedHost(
  headers: Record<string, unknown>,
  env: EnvLike = process.env,
): string | null {
  const value = headers['x-forwarded-host'];
  const raw =
    typeof value === 'string'
      ? value
      : Array.isArray(value) && typeof value[0] === 'string'
        ? value[0]
        : '';
  const first = raw.split(',')[0]?.trim();
  if (!first) return null;
  const host = normalizeHost(first);
  if (!host) return null;
  return getTrustedHostSet(env).has(host) ? host : null;
}
