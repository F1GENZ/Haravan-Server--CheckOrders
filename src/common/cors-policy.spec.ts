import { createCorsPolicy } from './cors-policy';

const base = {
  FRONTEND_URL: 'https://admin.example.test',
  API_BASE_URL: 'https://api.example.test',
  WIDGET_PUBLIC_URL: 'https://widget.example.test',
  CORS_ALLOWED_ORIGINS: 'https://pages.example.test',
};
const production = { ...base, NODE_ENV: 'production' };

const ADMIN = '/api/order-admin/settings';
const HEALTH = '/api/health';
const LOOKUP = '/api/order/lookup';
const EMBED = '/api/order/widget/shop/x/embed.js';

describe('CORS policy', () => {
  it('denies Haravan storefronts on admin and health paths in production', () => {
    const policy = createCorsPolicy(production);
    expect(policy.isAllowedOrigin('https://x.myharavan.com', ADMIN)).toBe(
      false,
    );
    expect(policy.isAllowedOrigin('https://myharavan.com', ADMIN)).toBe(false);
    expect(policy.isAllowedOrigin('https://x.myharavan.com', HEALTH)).toBe(
      false,
    );
  });

  it('still allows Haravan storefronts on the public lookup and widget paths', () => {
    const policy = createCorsPolicy(production);
    expect(policy.isAllowedOrigin('https://x.myharavan.com', LOOKUP)).toBe(
      true,
    );
    expect(policy.isAllowedOrigin('https://x.myharavan.com', EMBED)).toBe(true);
    expect(
      policy.isAllowedOrigin('https://myharavan.com', '/api/order/widget'),
    ).toBe(true);
  });

  it('keeps the static development origins on dynamic paths only', () => {
    const policy = createCorsPolicy(production);
    expect(policy.isAllowedOrigin('http://localhost:5173', LOOKUP)).toBe(true);
    expect(policy.isAllowedOrigin('capacitor://localhost', EMBED)).toBe(true);
    expect(policy.isAllowedOrigin('http://localhost:5173', ADMIN)).toBe(false);
    expect(policy.isAllowedOrigin('capacitor://localhost', HEALTH)).toBe(false);
    expect(policy.isAllowedOrigin('http://localhost:4000', LOOKUP)).toBe(false);
  });

  it('allows loopback hosts on every path outside production only', () => {
    const dev = createCorsPolicy({ ...base, NODE_ENV: 'test' });
    expect(dev.isAllowedOrigin('http://localhost:5173', ADMIN)).toBe(true);
    expect(dev.isAllowedOrigin('http://127.0.0.1:4000', HEALTH)).toBe(true);
    const prod = createCorsPolicy(production);
    expect(prod.isAllowedOrigin('http://127.0.0.1:4000', HEALTH)).toBe(false);
  });

  it('allows configured origins and f1genz.com hosts everywhere', () => {
    const policy = createCorsPolicy(production);
    for (const origin of [
      'https://admin.example.test',
      'https://api.example.test',
      'https://widget.example.test',
      'https://pages.example.test',
      'https://f1genz.com',
      'https://checkorders.f1genz.com',
    ]) {
      expect(policy.isAllowedOrigin(origin, ADMIN)).toBe(true);
      expect(policy.isAllowedOrigin(origin, LOOKUP)).toBe(true);
    }
  });

  it('denies unknown and malformed origins and lookalike hosts', () => {
    const policy = createCorsPolicy(production);
    expect(policy.isAllowedOrigin('https://evil.example', LOOKUP)).toBe(false);
    expect(policy.isAllowedOrigin('https://evilmyharavan.com', LOOKUP)).toBe(
      false,
    );
    expect(
      policy.isAllowedOrigin('https://f1genz.com.evil.example', ADMIN),
    ).toBe(false);
    expect(policy.isAllowedOrigin('not a url', LOOKUP)).toBe(false);
  });

  it('identifies the dynamic paths', () => {
    const { isDynamicCorsPath } = createCorsPolicy(production);
    expect(isDynamicCorsPath('/api/order/lookup')).toBe(true);
    expect(isDynamicCorsPath('/api/order/lookup?x=1')).toBe(true);
    expect(isDynamicCorsPath('/api/order/widget')).toBe(true);
    expect(isDynamicCorsPath(EMBED)).toBe(true);
    expect(isDynamicCorsPath(ADMIN)).toBe(false);
    expect(isDynamicCorsPath(HEALTH)).toBe(false);
  });
});
