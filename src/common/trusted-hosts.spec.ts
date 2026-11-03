import {
  getTrustedHostSet,
  resolveTrustedForwardedHost,
} from './trusted-hosts';

const env = {
  FRONTEND_URL: 'https://app.example.test/',
  API_BASE_URL: 'https://api.example.test',
  WIDGET_PUBLIC_URL: 'https://widget.example.test',
  WIDGET_API_URL: 'https://widget-api.example.test/',
  CORS_ALLOWED_ORIGINS:
    'https://pages.example.test, https://other.example.test',
};

describe('trusted hosts', () => {
  it('collects every configured host, including CORS_ALLOWED_ORIGINS', () => {
    expect([...getTrustedHostSet(env)].sort()).toEqual([
      'api.example.test',
      'app.example.test',
      'other.example.test',
      'pages.example.test',
      'widget-api.example.test',
      'widget.example.test',
    ]);
  });

  it('accepts a configured forwarded host and normalises case and port', () => {
    expect(
      resolveTrustedForwardedHost(
        { 'x-forwarded-host': 'Pages.Example.Test:443' },
        env,
      ),
    ).toBe('pages.example.test');
  });

  it('rejects an unknown forwarded host', () => {
    expect(
      resolveTrustedForwardedHost({ 'x-forwarded-host': 'evil.example' }, env),
    ).toBeNull();
  });

  it('only inspects the first value of a comma list', () => {
    expect(
      resolveTrustedForwardedHost(
        { 'x-forwarded-host': 'pages.example.test, evil.example' },
        env,
      ),
    ).toBe('pages.example.test');
    expect(
      resolveTrustedForwardedHost(
        { 'x-forwarded-host': 'evil.example, pages.example.test' },
        env,
      ),
    ).toBeNull();
  });

  it('handles array headers and a missing header', () => {
    expect(
      resolveTrustedForwardedHost(
        { 'x-forwarded-host': ['app.example.test'] },
        env,
      ),
    ).toBe('app.example.test');
    expect(resolveTrustedForwardedHost({}, env)).toBeNull();
  });

  it('trusts nothing when no host is configured', () => {
    expect(
      resolveTrustedForwardedHost(
        { 'x-forwarded-host': 'app.example.test' },
        {},
      ),
    ).toBeNull();
  });
});
