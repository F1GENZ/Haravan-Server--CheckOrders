type EnvLike = Record<string, string | undefined>;

const parseOrigins = (value?: string): string[] =>
  String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

/** Origins only the public widget/lookup paths accept without an env entry. */
const STATIC_DYNAMIC_PATH_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

// Public widget/lookup paths use OrderLookupCorsMiddleware for custom domains.
// Global OPTIONS must not 403 those routes before the dynamic middleware runs.
export const isDynamicCorsPath = (reqPath: string): boolean => {
  const path = String(reqPath || '');
  return (
    path === '/api/order/lookup' ||
    path.startsWith('/api/order/lookup?') ||
    path === '/api/order/widget' ||
    path.startsWith('/api/order/widget/')
  );
};

export interface CorsPolicy {
  isAllowedOrigin(origin: string, reqPath: string): boolean;
  isDynamicCorsPath(reqPath: string): boolean;
}

/**
 * Admin and health routes only trust the configured origins and f1genz.com.
 * Haravan storefronts (*.myharavan.com) and the static dev origins are
 * reflected with credentials solely on the public widget/lookup paths.
 */
export function createCorsPolicy(env: EnvLike = process.env): CorsPolicy {
  const isProduction = env.NODE_ENV === 'production';
  const configured = [
    env.FRONTEND_URL,
    env.API_BASE_URL,
    env.WIDGET_PUBLIC_URL,
    env.WIDGET_API_URL,
    ...parseOrigins(env.CORS_ALLOWED_ORIGINS),
  ].filter((origin): origin is string => Boolean(origin));

  const isAllowedOrigin = (origin: string, reqPath: string): boolean => {
    if (configured.includes(origin)) return true;
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'f1genz.com' || hostname.endsWith('.f1genz.com')) {
        return true;
      }
      if (
        !isProduction &&
        (hostname === 'localhost' || hostname === '127.0.0.1')
      ) {
        return true;
      }
      if (!isDynamicCorsPath(reqPath)) return false;
      if (STATIC_DYNAMIC_PATH_ORIGINS.includes(origin)) return true;
      return (
        hostname === 'myharavan.com' || hostname.endsWith('.myharavan.com')
      );
    } catch {
      return false;
    }
  };

  return { isAllowedOrigin, isDynamicCorsPath };
}
