import type { PoolConfig } from 'pg';

export type PgAdapterConfig = {
  poolConfig: PoolConfig;
  schema?: string;
};

// Query parameters that only the Prisma engine understood; pg must not see them.
const PRISMA_ONLY_PARAMS: Record<string, true> = {
  pgbouncer: true,
  schema: true,
  connection_limit: true,
  pool_timeout: true,
  connect_timeout: true,
  socket_timeout: true,
  statement_cache_size: true,
  sslmode: true,
  sslaccept: true,
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const VERIFYING_SSL_MODES: Record<string, true> = {
  'verify-ca': true,
  'verify-full': true,
};
const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
  '::1': true,
};

const positiveInt = (value: string | null): number | undefined => {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
};

const resolveSsl = (
  hostname: string,
  sslmode: string | null,
  sslaccept: string | null,
): PoolConfig['ssl'] => {
  const mode = (sslmode || '').toLowerCase();
  if (mode === 'disable') return false;
  if (!mode && Object.hasOwn(LOOPBACK_HOSTS, hostname.toLowerCase())) {
    return false;
  }
  if (Object.hasOwn(VERIFYING_SSL_MODES, mode) || sslaccept === 'strict') {
    return true;
  }
  // Prisma's engine encrypted without validating the certificate chain, and
  // managed poolers (Supabase) present a CA that Node does not trust by default.
  return { rejectUnauthorized: false };
};

export const buildPgAdapterConfig = (rawUrl: string): PgAdapterConfig => {
  const queryAt = rawUrl.indexOf('?');
  const base = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const params = new URLSearchParams(
    queryAt === -1 ? '' : rawUrl.slice(queryAt + 1),
  );

  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (!Object.hasOwn(PRISMA_ONLY_PARAMS, key)) kept.append(key, value);
  }
  const query = kept.toString();

  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    hostname = '';
  }

  const connectTimeoutSeconds = positiveInt(params.get('connect_timeout'));
  const poolConfig: PoolConfig = {
    connectionString: query ? `${base}?${query}` : base,
    ssl: resolveSsl(hostname, params.get('sslmode'), params.get('sslaccept')),
    connectionTimeoutMillis: connectTimeoutSeconds
      ? connectTimeoutSeconds * 1000
      : DEFAULT_CONNECT_TIMEOUT_MS,
  };
  const max = positiveInt(params.get('connection_limit'));
  if (max) poolConfig.max = max;

  const schema = params.get('schema')?.trim();
  return schema ? { poolConfig, schema } : { poolConfig };
};
