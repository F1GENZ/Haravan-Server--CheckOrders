import { buildPgAdapterConfig } from './pg-adapter-config';

describe('buildPgAdapterConfig', () => {
  const pooler =
    'postgresql://u:p@aws-0-ap.pooler.supabase.com:6543/postgres?pgbouncer=true';

  it('strips Prisma-only parameters and keeps the rest', () => {
    const { poolConfig } = buildPgAdapterConfig(
      `${pooler}&connection_limit=3&application_name=checkorders&schema=public`,
    );
    expect(poolConfig.connectionString).toBe(
      'postgresql://u:p@aws-0-ap.pooler.supabase.com:6543/postgres?application_name=checkorders',
    );
    expect(poolConfig.max).toBe(3);
  });

  it('returns a bare connection string when no parameter remains', () => {
    const { poolConfig } = buildPgAdapterConfig(pooler);
    expect(poolConfig.connectionString).toBe(
      'postgresql://u:p@aws-0-ap.pooler.supabase.com:6543/postgres',
    );
    expect(poolConfig.max).toBeUndefined();
  });

  it('exposes the schema parameter for the adapter', () => {
    expect(
      buildPgAdapterConfig('postgresql://u:p@h/db?schema=app').schema,
    ).toBe('app');
    expect(
      buildPgAdapterConfig('postgresql://u:p@h/db').schema,
    ).toBeUndefined();
  });

  it('keeps the previous 5s connect timeout unless overridden', () => {
    expect(
      buildPgAdapterConfig(pooler).poolConfig.connectionTimeoutMillis,
    ).toBe(5000);
    expect(
      buildPgAdapterConfig(`${pooler}&connect_timeout=12`).poolConfig
        .connectionTimeoutMillis,
    ).toBe(12000);
  });

  it('encrypts remote hosts without chain validation by default', () => {
    expect(buildPgAdapterConfig(pooler).poolConfig.ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('does not use TLS on loopback hosts unless asked', () => {
    expect(
      buildPgAdapterConfig('postgresql://u@127.0.0.1:5432/db').poolConfig.ssl,
    ).toBe(false);
    expect(
      buildPgAdapterConfig('postgresql://u@localhost/db?sslmode=require')
        .poolConfig.ssl,
    ).toEqual({ rejectUnauthorized: false });
  });

  it('honours explicit sslmode values', () => {
    expect(
      buildPgAdapterConfig('postgresql://u@h/db?sslmode=disable').poolConfig
        .ssl,
    ).toBe(false);
    expect(
      buildPgAdapterConfig('postgresql://u@h/db?sslmode=verify-full').poolConfig
        .ssl,
    ).toBe(true);
    expect(
      buildPgAdapterConfig('postgresql://u@h/db?sslaccept=strict').poolConfig
        .ssl,
    ).toBe(true);
  });
});
