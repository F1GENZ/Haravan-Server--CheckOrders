import {
  BadRequestException,
  UnauthorizedException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { HaravanAPIService } from './haravan.api';
import { StoreService } from '../order-lookup/services/store.service';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../database/prisma.service';
import axios from 'axios';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';

const REDIS_PREFIX = 'haravan:checkorders:app_install';
const OAUTH_STATE_PREFIX = 'haravan:checkorders:oauth_state';
const SHOP_DOMAIN_PREFIX = 'haravan:checkorders:shop_domain';
const SUBSCRIPTION_PREFIX = 'haravan:checkorders:app_subscriptions';
const REFRESH_LOCK_PREFIX = 'haravan:checkorders:token_refresh_lock';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_PRO_EXPIRES_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_QUOTA = 10;
const SAFE_LOGIN_SCOPE = 'openid profile email org userinfo';

type HaravanConfig = {
  frontEndUrl: string;
  urlAuthorize: string;
  urlConnectToken: string;
  clientId: string;
  clientSecret: string;
  loginCallbackUrl: string;
  installCallbackUrl: string;
  scopeLogin: string;
  scopeInstall: string;
  grantTypeInstall: string;
  grantTypeRefresh: string;
  responseType: string;
  oidcIssuer: string;
  oidcDiscoveryUrl: string;
  jwksUrl: string;
};

type RedisInstallData = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: number;
  orgid?: string;
  orgsub?: string;
  domain?: string;
  primary_domain?: string;
  myharavan_domain?: string;
  status?: string;
  plan?: string;
  expires_at?: number;
  installed_at?: number;
  quota_total?: number;
  quota_remaining?: number;
  subscription_status?: string;
  subscription_updated_at?: number;
  subscription_payload?: Record<string, unknown>;
  reinstall_reason?: string;
  reinstall_at?: number;
  haravan_token_status?: string;
  haravan_token_error?: string;
  haravan_token_error_code?: string;
  haravan_token_error_at?: number;
};

type AppSessionPayload = {
  orgid: string;
  type: 'haravan_app_session';
  iat: number;
  exp: number;
};

type OAuthFlow = 'login' | 'install';

type OAuthStateData = {
  flow: OAuthFlow;
  nonce: string;
  created_at: number;
};

type OAuthTokenPayload = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtClaims = Record<string, unknown> & {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
};

type Jwk = crypto.JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
};

type JwksPayload = {
  keys?: Jwk[];
};

type OidcDiscoveryPayload = {
  issuer?: string;
  jwks_uri?: string;
};

type HmacPair = {
  key: string;
  value: string;
  rawKey: string;
  rawValue: string;
};

type RawBodyRequest = Request & { rawBody?: Buffer; rawBodyText?: string };

type SubscriptionSnapshot = {
  orgid: string;
  status: string;
  plan: string;
  is_active: boolean;
  expires_at?: number;
  synced_at: number;
  subscription_payload?: Record<string, unknown>;
};

type AuthResponse = {
  url: string;
  orgid?: string;
  sessionToken?: string;
};

const asString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  return null;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
};

const normalizeShopDomain = (value: unknown): string => {
  const rawValue =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  if (!rawValue) return '';

  const withProtocol = /^https?:\/\//i.test(rawValue)
    ? rawValue
    : `https://${rawValue}`;

  try {
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return rawValue
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
};

const getInstallShopDomains = (data: RedisInstallData | null): string[] => {
  const domains = [
    normalizeShopDomain(data?.domain),
    normalizeShopDomain(data?.primary_domain),
    normalizeShopDomain(data?.myharavan_domain),
    normalizeShopDomain(data?.orgsub ? `${data.orgsub}.myharavan.com` : ''),
  ].filter(Boolean);

  return [...new Set(domains)];
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
};

const getHmacMessageCandidates = (rawQueryString: string): string[] => {
  const pairs = rawQueryString
    .split('&')
    .filter(Boolean)
    .map((part): HmacPair => {
      const eqIndex = part.indexOf('=');
      const rawKey = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
      const rawValue = eqIndex >= 0 ? part.slice(eqIndex + 1) : '';
      return {
        key: safeDecodeURIComponent(rawKey),
        value: safeDecodeURIComponent(rawValue),
        rawKey,
        rawValue,
      };
    })
    .filter((pair) => pair.key !== 'hmac' && pair.rawKey !== 'hmac');

  const candidates = [
    pairs.map((pair) => `${pair.key}=${pair.value}`).join('&'),
    pairs.map((pair) => `${pair.rawKey}=${pair.rawValue}`).join('&'),
  ].filter(Boolean);

  return [...new Set(candidates)];
};

const normalizeIssuer = (value: string): string => value.replace(/\/+$/, '');

const base64UrlDecode = (value: string): Buffer => {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(normalized, 'base64');
};

const decodeJwtJson = <T extends Record<string, unknown>>(
  value: string,
  label: string,
): T => {
  try {
    const decoded: unknown = JSON.parse(
      base64UrlDecode(value).toString('utf8'),
    );
    if (typeof decoded !== 'object' || decoded === null) {
      throw new Error(`${label} is not an object`);
    }
    return decoded as T;
  } catch {
    throw new BadRequestException(`Invalid id_token ${label}`);
  }
};

const parseJwt = (
  idToken: string,
): {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
} => {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new BadRequestException('Invalid id_token format');
  }
  return {
    header: decodeJwtJson<JwtHeader>(parts[0], 'header'),
    claims: decodeJwtJson<JwtClaims>(parts[1], 'payload'),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2]),
  };
};

const JWT_VERIFY_ALGORITHMS: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};

@Injectable()
export class HaravanService {
  private readonly logger = new Logger(HaravanService.name);
  private static readonly SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
  private static readonly REFRESH_WINDOW_MS = 30 * 60 * 1000;
  private jwksCache: { url: string; keys: Jwk[]; expiresAt: number } | null =
    null;

  constructor(
    private readonly config: ConfigService,
    private readonly redisService: RedisService,
    private readonly haravanAPI: HaravanAPIService,
    private readonly storeService: StoreService,
    @Optional()
    private readonly notificationService?: NotificationService,
    @Optional()
    private readonly db?: PrismaService,
  ) {}

  private getHaravanConfig(): HaravanConfig {
    return {
      frontEndUrl: this.config.get<string>('FRONTEND_URL') || '',
      urlAuthorize: this.config.get<string>('HRV_URL_AUTHORIZE') || '',
      urlConnectToken: this.config.get<string>('HRV_URL_CONNECT_TOKEN') || '',
      clientId: this.config.get<string>('HRV_CLIENT_ID') || '',
      clientSecret: this.config.get<string>('HRV_CLIENT_SECRET') || '',
      loginCallbackUrl: this.config.get<string>('HRV_LOGIN_CALLBACK_URL') || '',
      installCallbackUrl:
        this.config.get<string>('HRV_INSTALL_CALLBACK_URL') || '',
      scopeLogin: this.config.get<string>('HRV_SCOPE_LOGIN') || '',
      scopeInstall: this.config.get<string>('HRV_SCOPE_INSTALL') || '',
      grantTypeInstall: this.config.get<string>('HRV_GRANT_TYPE_INSTALL') || '',
      grantTypeRefresh: this.config.get<string>('HRV_GRANT_TYPE_REFRESH') || '',
      responseType: this.config.get<string>('HRV_RESPONSE_TYPE') || '',
      oidcIssuer: this.config.get<string>('HRV_OIDC_ISSUER') || '',
      oidcDiscoveryUrl: this.config.get<string>('HRV_OIDC_DISCOVERY_URL') || '',
      jwksUrl: this.config.get<string>('HRV_JWKS_URL') || '',
    };
  }

  private sessionKey(orgid: string): string {
    return `${REDIS_PREFIX}:${orgid}`;
  }

  private oauthStateKey(state: string): string {
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    return `${OAUTH_STATE_PREFIX}:${stateHash}`;
  }

  private subscriptionKey(orgid: string): string {
    return `${SUBSCRIPTION_PREFIX}:${orgid}`;
  }

  private sessionTtlSeconds(): number {
    const explicit = Number(this.config.get<string>('APP_SESSION_TTL_SECONDS'));
    if (Number.isFinite(explicit) && explicit >= 300) return explicit;

    const raw = String(this.config.get<string>('APP_SESSION_TTL') || '').trim();
    const match = raw.match(/^(\d+)\s*([smhd])?$/i);
    if (match) {
      const amount = Number(match[1]);
      const unit = (match[2] || 's').toLowerCase();
      const multiplier =
        unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
      const seconds = amount * multiplier;
      if (seconds >= 300) return seconds;
    }

    return 12 * 60 * 60;
  }

  private getSessionSecret(): string {
    const secret =
      this.config.get<string>('APP_SESSION_SECRET') ||
      this.config.get<string>('HRV_CLIENT_SECRET') ||
      '';
    if (!secret) throw new UnauthorizedException('Session secret missing');
    return secret;
  }

  private signSessionPayload(payload: AppSessionPayload): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.getSessionSecret())
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  private createSessionToken(orgid: string): string {
    const now = Math.floor(Date.now() / 1000);
    return this.signSessionPayload({
      orgid,
      type: 'haravan_app_session',
      iat: now,
      exp: now + this.sessionTtlSeconds(),
    });
  }

  verifySessionToken(sessionToken: string): AppSessionPayload {
    const parts = String(sessionToken || '').split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid auth session');
    }

    const expected = crypto
      .createHmac('sha256', this.getSessionSecret())
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(parts[2]);
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new UnauthorizedException('Invalid auth session');
    }

    let payload: AppSessionPayload;
    try {
      payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as AppSessionPayload;
    } catch {
      throw new UnauthorizedException('Invalid auth session');
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      payload.type !== 'haravan_app_session' ||
      !payload.orgid ||
      !payload.exp ||
      payload.exp <= now
    ) {
      throw new UnauthorizedException('Expired auth session');
    }
    return payload;
  }

  private async createOAuthState(
    flow: OAuthFlow,
  ): Promise<{ state: string; nonce: string }> {
    const state = `f1g_oauth_${crypto.randomBytes(32).toString('hex')}`;
    const nonce = `f1g_nonce_${crypto.randomBytes(32).toString('hex')}`;
    await this.redisService.set(
      this.oauthStateKey(state),
      {
        flow,
        nonce,
        created_at: Date.now(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    return { state, nonce };
  }

  private async consumeOAuthState(
    state: string | undefined,
    expectedFlow: OAuthFlow,
  ): Promise<OAuthStateData> {
    if (!state || !/^f1g_oauth_[a-f0-9]{64}$/.test(state)) {
      throw new UnauthorizedException('Invalid OAuth state');
    }

    const key = this.oauthStateKey(state);
    const data = await this.redisService.get<OAuthStateData>(key);
    await this.redisService.del(key);

    if (!data?.nonce || data.flow !== expectedFlow) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    return data;
  }

  private getOidcIssuer(): string {
    const c = this.getHaravanConfig();
    const configuredIssuer = c.oidcIssuer.trim();
    if (configuredIssuer) return normalizeIssuer(configuredIssuer);

    try {
      return normalizeIssuer(new URL(c.urlAuthorize).origin);
    } catch {
      throw new BadRequestException('OIDC issuer is not configured');
    }
  }

  private async getJwksUrl(issuer: string): Promise<string> {
    const c = this.getHaravanConfig();
    if (c.jwksUrl.trim()) return c.jwksUrl.trim();

    const discoveryUrl =
      c.oidcDiscoveryUrl.trim() ||
      `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
    const response = await axios.get<OidcDiscoveryPayload>(discoveryUrl, {
      timeout: 5000,
    });
    const jwksUrl = asString(response.data?.jwks_uri);
    if (!jwksUrl) {
      throw new UnauthorizedException('OIDC JWKS URL is not configured');
    }
    return jwksUrl;
  }

  private async getJwks(forceRefresh = false): Promise<Jwk[]> {
    const issuer = this.getOidcIssuer();
    const jwksUrl = await this.getJwksUrl(issuer);
    if (
      !forceRefresh &&
      this.jwksCache?.url === jwksUrl &&
      this.jwksCache.expiresAt > Date.now()
    ) {
      return this.jwksCache.keys;
    }

    const response = await axios.get<JwksPayload>(jwksUrl, { timeout: 5000 });
    const keys = Array.isArray(response.data?.keys) ? response.data.keys : [];
    if (!keys.length) throw new UnauthorizedException('OIDC JWKS is empty');
    this.jwksCache = {
      url: jwksUrl,
      keys,
      expiresAt: Date.now() + JWKS_CACHE_TTL_MS,
    };
    return keys;
  }

  private selectJwk(keys: Jwk[], header: JwtHeader): Jwk | null {
    if (header.kid) {
      const byKid = keys.find((key) => key.kid === header.kid);
      if (byKid) return byKid;
    }
    const signingKeys = keys.filter((key) => key.use !== 'enc');
    if (signingKeys.length === 1) return signingKeys[0];
    return null;
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<JwtClaims> {
    const parsed = parseJwt(idToken);
    const verifyAlgorithm = JWT_VERIFY_ALGORITHMS[parsed.header.alg || ''];
    if (!verifyAlgorithm) {
      throw new UnauthorizedException('Unsupported id_token algorithm');
    }

    let jwk = this.selectJwk(await this.getJwks(), parsed.header);
    if (!jwk && parsed.header.kid) {
      jwk = this.selectJwk(await this.getJwks(true), parsed.header);
    }
    if (!jwk) throw new UnauthorizedException('id_token key not found');

    const publicKey = crypto.createPublicKey({
      key: jwk,
      format: 'jwk',
    });
    const validSignature = crypto.verify(
      verifyAlgorithm,
      Buffer.from(parsed.signingInput),
      publicKey,
      parsed.signature,
    );
    if (!validSignature) {
      throw new UnauthorizedException('Invalid id_token signature');
    }

    const issuer = this.getOidcIssuer();
    const tokenIssuer = asString(parsed.claims.iss);
    if (!tokenIssuer || normalizeIssuer(tokenIssuer) !== issuer) {
      throw new UnauthorizedException('Invalid id_token issuer');
    }

    const c = this.getHaravanConfig();
    const audience = parsed.claims.aud;
    const validAudience = Array.isArray(audience)
      ? audience.includes(c.clientId)
      : audience === c.clientId;
    if (!validAudience) {
      throw new UnauthorizedException('Invalid id_token audience');
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = Number(parsed.claims.exp);
    if (!Number.isFinite(exp) || exp + JWT_CLOCK_SKEW_SECONDS <= now) {
      throw new UnauthorizedException('Expired id_token');
    }

    const nbf = Number(parsed.claims.nbf);
    if (Number.isFinite(nbf) && nbf - JWT_CLOCK_SKEW_SECONDS > now) {
      throw new UnauthorizedException('id_token is not active yet');
    }

    const iat = Number(parsed.claims.iat);
    if (Number.isFinite(iat) && iat - JWT_CLOCK_SKEW_SECONDS > now) {
      throw new UnauthorizedException('Invalid id_token issue time');
    }

    if (parsed.claims.nonce !== expectedNonce) {
      throw new UnauthorizedException('Invalid id_token nonce');
    }

    return parsed.claims;
  }

  resolveAdminSessionToken(
    sessionToken: string,
    requestedOrgid: string,
  ): string {
    const session = this.verifySessionToken(sessionToken);
    if (session.orgid !== requestedOrgid) {
      throw new UnauthorizedException('Orgid does not match auth session');
    }
    return session.orgid;
  }

  private buildFrontendUrl(
    orgid: string,
    pathname = '/',
    extraParams: Record<string, string> = {},
  ): string {
    const c = this.getHaravanConfig();
    const baseUrl = c.frontEndUrl || 'http://localhost:5173';
    const url = new URL(
      /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`,
    );
    url.pathname = pathname;
    url.search = '';
    url.searchParams.set('orgid', orgid);
    Object.entries(extraParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  }

  private buildSessionResponse(
    orgid: string,
    pathname = '/',
    extraParams: Record<string, string> = {},
  ): AuthResponse {
    const sessionToken = this.createSessionToken(orgid);
    return {
      url: this.buildFrontendUrl(orgid, pathname, extraParams),
      orgid,
      sessionToken,
    };
  }

  private buildSessionRedirectUrl(payload: AuthResponse): string {
    if (!payload.sessionToken) return payload.url;
    const separator = payload.url.includes('#') ? '&' : '#';
    return `${payload.url}${separator}session_token=${encodeURIComponent(
      payload.sessionToken,
    )}`;
  }

  private getHmacSecrets(): string[] {
    return [this.config.get<string>('HRV_CLIENT_SECRET')]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }

  private getWebhookHmacSecrets(): string[] {
    return [
      this.config.get<string>('HRV_CLIENT_SECRET'),
      this.config.get<string>('HRV_WEBHOOK_SECRET'),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }

  private async saveShopOrgIndex(
    orgid: string,
    domains: string[],
  ): Promise<void> {
    const uniqueDomains = [...new Set(domains.map(normalizeShopDomain))].filter(
      Boolean,
    );
    await Promise.all(
      uniqueDomains.map((domain) =>
        this.redisService.set(`${SHOP_DOMAIN_PREFIX}:${domain}`, orgid),
      ),
    );
  }

  private async resolveOrgidFromShop(
    shop: string | null,
  ): Promise<string | null> {
    const domain = normalizeShopDomain(shop);
    if (!domain) return null;

    const indexed = await this.redisService.get<{ orgid?: string } | string>(
      `${SHOP_DOMAIN_PREFIX}:${domain}`,
    );
    if (typeof indexed === 'string' && indexed) return indexed;
    if (indexed && typeof indexed === 'object' && indexed.orgid) {
      return indexed.orgid;
    }

    const store = await this.storeService.getStoreByDomain(domain);
    if (store?.org_id) return store.org_id;

    const installKeys = await this.redisService.getKeys(`${REDIS_PREFIX}:*`);
    for (const key of installKeys) {
      const appData = await this.redisService.get<RedisInstallData>(key);
      const domains = getInstallShopDomains(appData);
      if (!domains.includes(domain)) continue;

      const orgid = appData?.orgid || key.replace(`${REDIS_PREFIX}:`, '');
      if (!orgid) return null;
      await this.saveShopOrgIndex(orgid, domains);
      return orgid;
    }

    return null;
  }

  private async getInstallSession(
    orgid: string,
  ): Promise<RedisInstallData | null> {
    const cached = await this.redisService.get<RedisInstallData>(
      this.sessionKey(orgid),
    );
    if (cached) return cached;

    const stored = (await this.db?.findInstallSession(orgid)) as
      | RedisInstallData
      | null
      | undefined;
    if (stored) {
      await this.redisService.set(
        this.sessionKey(orgid),
        stored,
        this.getInstallTtlSeconds(stored),
      );
    }
    return stored || null;
  }

  private isProApp(data: RedisInstallData | null | undefined): boolean {
    if (!data) return false;
    const status = String(data.status || '').toLowerCase();
    const plan = String(data.plan || '').toLowerCase();
    const subscriptionStatus = String(
      data.subscription_status || '',
    ).toLowerCase();
    const hasValidExpiry =
      !data.expires_at ||
      (typeof data.expires_at === 'number' && data.expires_at > Date.now());
    return (
      plan === 'pro' ||
      subscriptionStatus === 'active' ||
      (['active', 'accepted', 'approved'].includes(status) && hasValidExpiry)
    );
  }

  private requiresInstall(data: RedisInstallData | null | undefined): boolean {
    if (!data) return true;
    if (this.isProApp(data)) return false;
    const status = String(data.status || '').toLowerCase();
    return [
      'needs_reinstall',
      'unactive',
      'canceled',
      'expired',
      'declined',
    ].includes(status);
  }

  private isAccessTokenExpired(data: RedisInstallData): boolean {
    return (
      typeof data.token_expires_at === 'number' &&
      data.token_expires_at <= Date.now()
    );
  }

  private isAccessTokenExpirySuspicious(data: RedisInstallData): boolean {
    const maxExpectedTtl = Number(
      this.config.get<string>('HARAVAN_ACCESS_TOKEN_MAX_EXPECTED_TTL_MS'),
    );
    if (!Number.isFinite(maxExpectedTtl) || maxExpectedTtl <= 0) return false;
    const threshold = Math.max(maxExpectedTtl, 3 * 365 * 24 * 60 * 60 * 1000);
    return (
      typeof data.token_expires_at === 'number' &&
      data.token_expires_at - Date.now() > threshold
    );
  }

  private shouldRefreshAccessToken(data: RedisInstallData): boolean {
    const tokenExpiresAt =
      typeof data.token_expires_at === 'number' ? data.token_expires_at : null;
    return (
      !tokenExpiresAt ||
      tokenExpiresAt - Date.now() < HaravanService.REFRESH_WINDOW_MS ||
      this.isAccessTokenExpirySuspicious(data)
    );
  }

  private getInstallTtlSeconds(data: RedisInstallData): number | undefined {
    if (this.isProApp(data)) return undefined;

    if (typeof data.expires_at === 'number' && data.expires_at > Date.now()) {
      return Math.max(60, Math.ceil((data.expires_at - Date.now()) / 1000));
    }
    return HaravanService.SESSION_TTL_SECONDS;
  }

  private async saveInstallSession(
    orgid: string,
    data: RedisInstallData,
  ): Promise<void> {
    await this.redisService.set(
      this.sessionKey(orgid),
      data,
      this.getInstallTtlSeconds(data),
    );
    await this.db?.upsertInstallSession(orgid, data);
  }

  private installMatchesShop(
    appData: RedisInstallData | null,
    shop: string | null,
  ): boolean {
    const normalizedShop = normalizeShopDomain(shop);
    if (!appData || !normalizedShop) return false;
    return getInstallShopDomains(appData).includes(normalizedShop);
  }

  private async markNeedsReinstall(
    orgid: string,
    appData: RedisInstallData,
    reason: string,
  ): Promise<void> {
    const updated: RedisInstallData = {
      ...appData,
      status: 'needs_reinstall',
      reinstall_reason: reason,
      reinstall_at: Date.now(),
    };
    await this.saveInstallSession(orgid, updated);
    await this.notificationService?.notify('APP_NEEDS_REINSTALL', {
      orgid,
      reason,
    });
  }

  private getOAuthErrorCode(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data: unknown = error.response?.data;
      if (typeof data === 'object' && data !== null) {
        const payload = data as Record<string, unknown>;
        return (
          [
            payload.error,
            payload.error_code,
            payload.code,
            error.response?.status,
          ]
            .map(asString)
            .find(Boolean) || ''
        );
      }
      if (typeof data === 'string' && data.trim()) return data.trim();
      if (error.response?.status) return String(error.response.status);
    }
    return '';
  }

  private async markTokenRefreshFailure(
    orgid: string,
    appData: RedisInstallData,
    error: unknown,
  ): Promise<string> {
    const errorCode = this.getOAuthErrorCode(error);
    const normalizedCode = errorCode.toLowerCase();
    const updated: RedisInstallData = {
      ...appData,
      haravan_token_status:
        normalizedCode === 'invalid_grant' ? 'invalid_grant' : 'refresh_failed',
      haravan_token_error: getErrorMessage(error),
      haravan_token_error_code: errorCode || undefined,
      haravan_token_error_at: Date.now(),
    };
    await this.saveInstallSession(orgid, updated);
    return normalizedCode;
  }

  // ─── Resolve Access Token (for ShopAuthGuard) ───

  async resolveAccessToken(orgid: string): Promise<string> {
    const session = await this.getInstallSession(orgid);
    if (!session?.access_token) {
      throw new UnauthorizedException('Session expired, please login again');
    }

    if (this.requiresInstall(session)) {
      this.logger.warn(`App status ${session.status} for orgid: ${orgid}`);
      throw new UnauthorizedException(
        'App needs reinstall. Please login again.',
      );
    }

    const isPro = this.isProApp(session);
    const expired = this.isAccessTokenExpired(session);
    const suspicious = this.isAccessTokenExpirySuspicious(session);

    if (
      String(session.haravan_token_status || '').toLowerCase() ===
      'invalid_grant'
    ) {
      if (isPro) return session.access_token;
      await this.markNeedsReinstall(orgid, session, 'Refresh token is invalid');
      throw new UnauthorizedException('Session expired, please login again');
    }

    if (this.shouldRefreshAccessToken(session) && session.refresh_token) {
      const lockKey = `${REFRESH_LOCK_PREFIX}:${orgid}`;
      const lockAcquired = await this.redisService.setNx(lockKey, '1', 30);

      if (lockAcquired) {
        try {
          const newToken = await this.refreshToken(
            orgid,
            session.refresh_token,
          );
          if (newToken) {
            return newToken;
          }
        } catch (refreshError) {
          const errorCode = await this.markTokenRefreshFailure(
            orgid,
            session,
            refreshError,
          );
          this.logger.warn(
            `Failed to refresh token for orgid ${orgid}: ${getErrorMessage(refreshError)}`,
          );
          if (errorCode !== 'invalid_grant') {
            await this.notificationService?.notify('TOKEN_REFRESH_FAILED', {
              orgid,
              message: getErrorMessage(refreshError),
            });
          }

          if (expired || suspicious) {
            if (isPro) return session.access_token;
            await this.markNeedsReinstall(
              orgid,
              session,
              'Refresh token failed after access token expired',
            );
            throw new UnauthorizedException(
              'Session expired, please login again',
            );
          }
        } finally {
          await this.redisService.del(lockKey);
        }
      } else {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const freshData = await this.getInstallSession(orgid);
          if (!freshData?.access_token) continue;
          if (!this.shouldRefreshAccessToken(freshData)) {
            return freshData.access_token;
          }
        }
      }
    }

    if (expired || suspicious) {
      if (isPro) return session.access_token;
      if (!session.refresh_token) {
        await this.markNeedsReinstall(
          orgid,
          session,
          'Missing refresh token after access token expired',
        );
      }
      throw new UnauthorizedException('Session expired, please login again');
    }

    return session.access_token;
  }

  // ─── HMAC Verification (Haravan Admin app launch) ───

  async verifyHmac(rawQueryString: string): Promise<{
    valid: boolean;
    orgid?: string;
    sessionToken?: string;
    reason?: string;
  }> {
    const params = new URLSearchParams(rawQueryString);
    const hmac = String(params.get('hmac') || '')
      .trim()
      .toLowerCase();
    if (!hmac) return { valid: false, reason: 'Missing hmac' };
    if (!/^[a-f0-9]{64}$/.test(hmac)) {
      return { valid: false, reason: 'Invalid hmac' };
    }

    const hmacSecrets = this.getHmacSecrets();
    if (!hmacSecrets.length) {
      return { valid: false, reason: 'HMAC secret is not configured' };
    }

    const messages = getHmacMessageCandidates(rawQueryString);
    const validHmac = hmacSecrets.some((secret) =>
      messages.some((message) => {
        const computed = crypto
          .createHmac('sha256', secret)
          .update(message)
          .digest('hex');
        return crypto.timingSafeEqual(
          Buffer.from(computed, 'hex'),
          Buffer.from(hmac, 'hex'),
        );
      }),
    );

    if (!validHmac) {
      this.logger.warn(`HMAC mismatch for shop: ${params.get('shop') || ''}`);
      return { valid: false, reason: 'HMAC mismatch' };
    }

    // Check timestamp freshness (reject if > 5 minutes old)
    const timestampParam = params.get('timestamp');
    const timestamp = parseInt(timestampParam || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (timestampParam && Math.abs(now - timestamp) > 300) {
      this.logger.warn(
        `HMAC timestamp expired for orgid/shop: ${params.get('orgid') || params.get('shop') || ''}`,
      );
      return { valid: false, reason: 'Timestamp expired' };
    }

    const orgid =
      params.get('orgid') ||
      (await this.resolveOrgidFromShop(params.get('shop')));
    if (!orgid) return { valid: false, reason: 'Missing orgid mapping' };

    const appData = await this.getInstallSession(orgid);

    if (!appData || !appData.access_token) {
      this.logger.log(`HMAC valid but app not installed for orgid: ${orgid}`);
      return { valid: false, reason: 'App not installed' };
    }

    if (this.requiresInstall(appData)) {
      this.logger.log(`HMAC valid but app status: ${appData.status}`);
      return { valid: false, reason: `App status: ${appData.status}` };
    }

    const shop = params.get('shop');
    if (shop && !this.installMatchesShop(appData, shop)) {
      return { valid: false, reason: 'Shop does not match orgid' };
    }

    try {
      await this.resolveAccessToken(orgid);
    } catch (e) {
      this.logger.warn(`HMAC token check failed: ${getErrorMessage(e)}`);
      return { valid: false, reason: 'Token unavailable' };
    }

    this.logger.log(`HMAC verified, auto-login orgid: ${orgid}`);
    return {
      valid: true,
      orgid,
      sessionToken: this.createSessionToken(orgid),
    };
  }

  // ─── Build OAuth URLs ───

  private shouldAutoSubscribeWebhook(): boolean {
    const configured = this.config.get<string>('HRV_WEBHOOK_AUTO_SUBSCRIBE');
    if (typeof configured === 'string' && configured.trim()) {
      return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
    }
    return Boolean(
      String(this.config.get<string>('HRV_WEBHOOK_URL') || '').trim() ||
      String(this.config.get<string>('HRV_WEBHOOK_SECRET') || '').trim(),
    );
  }

  private getInstallScope(scopeInstall: string): string {
    const scopes = scopeInstall
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (this.shouldAutoSubscribeWebhook() && !scopes.includes('wh_api')) {
      scopes.push('wh_api');
    }
    return [...new Set(scopes)].join(' ');
  }

  private async buildUrlInstall(): Promise<string> {
    const c = this.getHaravanConfig();
    const oauthState = await this.createOAuthState('install');
    const params = new URLSearchParams({
      response_type: c.responseType,
      scope: this.getInstallScope(c.scopeInstall),
      client_id: c.clientId,
      redirect_uri: c.installCallbackUrl,
      response_mode: 'query',
      state: oauthState.state,
      nonce: oauthState.nonce,
    });
    return `${c.urlAuthorize}?${params.toString()}`;
  }

  private async buildUrlLogin(): Promise<string> {
    const c = this.getHaravanConfig();
    const oauthState = await this.createOAuthState('login');
    const params = new URLSearchParams({
      response_type: c.responseType,
      scope: SAFE_LOGIN_SCOPE,
      client_id: c.clientId,
      redirect_uri: c.loginCallbackUrl,
      response_mode: 'query',
      state: oauthState.state,
      nonce: oauthState.nonce,
    });
    return `${c.urlAuthorize}?${params.toString()}`;
  }

  // ─── Login Flow ───

  async buildReconnectUrl(): Promise<AuthResponse> {
    return { url: await this.buildUrlLogin() };
  }

  async getConnectionHealth(
    orgid: string,
    verifyToken = false,
  ): Promise<Record<string, unknown>> {
    const appData = await this.getInstallSession(orgid);
    const now = Date.now();
    let accessTokenResolvable: boolean | null = null;
    let accessTokenError: string | undefined;

    if (verifyToken && appData?.access_token) {
      try {
        await this.resolveAccessToken(orgid);
        accessTokenResolvable = true;
      } catch (error) {
        accessTokenResolvable = false;
        accessTokenError = getErrorMessage(error);
      }
    }

    const tokenExpiresAt =
      typeof appData?.token_expires_at === 'number'
        ? new Date(appData.token_expires_at).toISOString()
        : null;
    const appExpiresAt =
      typeof appData?.expires_at === 'number'
        ? new Date(appData.expires_at).toISOString()
        : null;

    return {
      installed: Boolean(appData?.access_token),
      orgid,
      status: appData?.status || 'unknown',
      plan: appData?.plan || 'Trial',
      domains: getInstallShopDomains(appData),
      token: {
        has_access_token: Boolean(appData?.access_token),
        has_refresh_token: Boolean(appData?.refresh_token),
        access_token_resolvable: accessTokenResolvable,
        access_token_error: accessTokenError,
        expires_at: tokenExpiresAt,
        expires_in_seconds:
          typeof appData?.token_expires_at === 'number'
            ? Math.floor((appData.token_expires_at - now) / 1000)
            : null,
        expired: appData ? this.isAccessTokenExpired(appData) : true,
        suspicious_expiry: appData
          ? this.isAccessTokenExpirySuspicious(appData)
          : false,
        refresh_status: appData?.haravan_token_status || 'ok',
        refresh_error_code: appData?.haravan_token_error_code,
        refresh_error_at:
          typeof appData?.haravan_token_error_at === 'number'
            ? new Date(appData.haravan_token_error_at).toISOString()
            : null,
      },
      subscription: {
        status: appData?.subscription_status || appData?.status || 'unknown',
        plan: appData?.plan || 'Trial',
        expires_at: appExpiresAt,
        updated_at:
          typeof appData?.subscription_updated_at === 'number'
            ? new Date(appData.subscription_updated_at).toISOString()
            : null,
      },
      webhook: {
        configured: Boolean(
          String(this.config.get<string>('HRV_WEBHOOK_URL') || '').trim(),
        ),
        secret_configured: Boolean(
          String(this.config.get<string>('HRV_WEBHOOK_SECRET') || '').trim(),
        ),
        auto_subscribe: this.shouldAutoSubscribeWebhook(),
      },
      checked_at: new Date().toISOString(),
    };
  }

  async loginApp(
    orgid?: string | string[],
    shop?: string | string[],
  ): Promise<AuthResponse> {
    const rawOrgid = Array.isArray(orgid)
      ? orgid.find((o) => o && o !== 'null' && o !== 'undefined' && o !== '')
      : orgid;
    const rawShop = Array.isArray(shop)
      ? shop.find((s) => s && s !== 'null' && s !== 'undefined' && s !== '')
      : shop;

    if (
      !rawOrgid ||
      rawOrgid === 'null' ||
      rawOrgid === 'undefined' ||
      rawOrgid === ''
    ) {
      return { url: await this.buildUrlLogin() };
    }

    const cleanOrgid = rawOrgid.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const appData = await this.getInstallSession(cleanOrgid);

      this.logger.log(
        `Redis check orgid: ${cleanOrgid} exists: ${!!appData} status: ${appData?.status}`,
      );

      if (!appData) {
        return { url: await this.buildUrlLogin() };
      }

      if (this.requiresInstall(appData)) {
        this.logger.log(`App status ${appData.status}, redirecting to install`);
        return { url: await this.buildUrlInstall() };
      }

      if (rawShop) {
        const normalizedShop = normalizeShopDomain(rawShop);
        const mappedOrgid = await this.resolveOrgidFromShop(normalizedShop);
        if (mappedOrgid && mappedOrgid !== cleanOrgid) {
          this.logger.warn(
            `Shop/orgid mismatch on launch: ${normalizedShop} -> ${mappedOrgid}, requested ${cleanOrgid}`,
          );
          return { url: await this.buildUrlLogin() };
        }

        if (this.installMatchesShop(appData, normalizedShop)) {
          await this.saveShopOrgIndex(
            cleanOrgid,
            getInstallShopDomains(appData),
          );
        }
      }

      // App is installed — still require OAuth SSO to prove identity
      return { url: await this.buildUrlLogin() };
    } catch (error) {
      this.logger.error(`Login error: ${getErrorMessage(error)}`);
      return { url: await this.buildUrlLogin() };
    }
  }

  // ─── Login Callback ───

  async processLoginCallback(
    code: string,
    state: string | undefined,
    req: Request,
    res: Response,
  ): Promise<void> {
    const c = this.getHaravanConfig();

    try {
      if (!code) throw new BadRequestException('Missing Code');
      const oauthState = await this.consumeOAuthState(state, 'login');
      const params = new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: c.loginCallbackUrl,
      });

      this.logger.log('Exchanging login code...');
      const response = await axios.post<OAuthTokenPayload>(
        c.urlConnectToken,
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const { id_token } = response.data;
      if (!id_token) throw new Error('No id_token returned');

      const decoded = await this.verifyIdToken(id_token, oauthState.nonce);
      const orgid = asString(decoded.orgid);
      if (!orgid) throw new BadRequestException('Missing orgid in id_token');
      this.logger.log(`Login callback orgid: ${orgid}`);

      const acceptHeader =
        typeof req.headers?.accept === 'string' ? req.headers.accept : '';
      const appData = await this.getInstallSession(orgid);

      if (appData?.access_token) {
        if (this.requiresInstall(appData)) {
          const installUrl = await this.buildUrlInstall();
          if (acceptHeader.includes('application/json')) {
            res.json({ url: installUrl });
            return;
          }
          res.redirect(installUrl);
          return;
        }

        await this.resolveAccessToken(orgid);
        const payload = this.buildSessionResponse(orgid);
        if (acceptHeader.includes('application/json')) {
          res.json(payload);
          return;
        }
        res.redirect(this.buildSessionRedirectUrl(payload));
        return;
      } else {
        // Not installed → redirect to Install
        const installUrl = await this.buildUrlInstall();
        if (acceptHeader.includes('application/json')) {
          res.json({ url: installUrl });
          return;
        }
        res.redirect(installUrl);
        return;
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(`Login callback error: ${errorMessage}`);
      const acceptHeader =
        typeof req.headers?.accept === 'string' ? req.headers.accept : '';
      if (acceptHeader.includes('application/json')) {
        res.status(400).json({ error: errorMessage });
        return;
      }
      res.redirect(
        `${c.frontEndUrl}/install/login?error=oauth_callback_failed&message=${encodeURIComponent(errorMessage)}`,
      );
      return;
    }
  }

  // ─── Install Flow ───

  async installApp(
    code: string,
    state: string | undefined,
    res: Response,
  ): Promise<void> {
    const c = this.getHaravanConfig();

    try {
      if (!code) throw new BadRequestException('Missing Code');
      const oauthState = await this.consumeOAuthState(state, 'install');
      const params = new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: c.grantTypeInstall,
        redirect_uri: c.installCallbackUrl,
      });

      const response = await axios.post<OAuthTokenPayload>(
        c.urlConnectToken,
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.data) throw new BadRequestException();
      const { id_token, access_token, expires_in, refresh_token } =
        response.data;
      if (!id_token || !access_token || !expires_in) {
        throw new BadRequestException('Invalid OAuth token payload');
      }

      const decoded = await this.verifyIdToken(id_token, oauthState.nonce);
      const orgid = asString(decoded.orgid);
      const orgsub = asString(decoded.orgsub) || undefined;
      if (!orgid) throw new BadRequestException('Missing orgid in id_token');
      this.logger.log(`Install orgid: ${orgid} orgsub: ${orgsub}`);

      const existingApp = await this.getInstallSession(orgid);
      let shopData: Record<string, unknown> = {};
      try {
        shopData = await this.haravanAPI.getShop(access_token);
      } catch (shopError) {
        this.logger.warn(
          `Failed to fetch shop info: ${getErrorMessage(shopError)}`,
        );
      }

      const tokenExpiresAt = Date.now() + expires_in * 1000;
      await this.subscribeWebhooks(access_token);
      const subscriptionSnapshot = await this.getSubscriptionSnapshot(orgid);
      const hasActiveSubscription =
        Boolean(subscriptionSnapshot?.is_active) || this.isProApp(existingApp);
      const existingNeedsInstall =
        existingApp && !this.isProApp(existingApp)
          ? this.requiresInstall(existingApp)
          : false;
      const resolvedStatus = hasActiveSubscription
        ? 'active'
        : existingNeedsInstall
          ? 'trial'
          : existingApp?.status || 'trial';
      const resolvedPlan = hasActiveSubscription ? 'Pro' : 'Trial';
      const resolvedExpiresAt = hasActiveSubscription
        ? subscriptionSnapshot?.expires_at ||
          existingApp?.expires_at ||
          Date.now() + DEFAULT_PRO_EXPIRES_MS
        : existingNeedsInstall || !existingApp?.expires_at
          ? Date.now() + DEFAULT_TRIAL_MS
          : existingApp.expires_at;
      const resolvedQuotaTotal = hasActiveSubscription
        ? existingApp?.quota_total || this.proQuota()
        : existingApp?.quota_total || DEFAULT_TRIAL_QUOTA;
      const resolvedQuotaRemaining = hasActiveSubscription
        ? (existingApp?.quota_remaining ?? resolvedQuotaTotal)
        : (existingApp?.quota_remaining ?? resolvedQuotaTotal);

      const tokenData: RedisInstallData = {
        access_token,
        refresh_token: refresh_token || undefined,
        token_expires_at: tokenExpiresAt,
        orgid,
        orgsub,
        domain: asString(shopData.domain) || undefined,
        primary_domain: asString(shopData.primary_domain) || undefined,
        myharavan_domain: asString(shopData.myharavan_domain) || undefined,
        status: resolvedStatus,
        plan: resolvedPlan,
        expires_at: resolvedExpiresAt,
        installed_at: existingApp?.installed_at || Date.now(),
        quota_total: resolvedQuotaTotal,
        quota_remaining: resolvedQuotaRemaining,
        subscription_status: subscriptionSnapshot?.status,
        subscription_updated_at: subscriptionSnapshot?.synced_at,
      };

      await this.saveInstallSession(orgid, tokenData);

      // ─── Auto-register store in Order Lookup system ───
      try {
        const shopDomains = getInstallShopDomains(tokenData);
        const shopDomain =
          tokenData.primary_domain ||
          tokenData.domain ||
          tokenData.myharavan_domain ||
          `${orgid}.myharavan.com`;
        const customDomain =
          tokenData.domain && tokenData.domain !== tokenData.myharavan_domain
            ? tokenData.domain
            : undefined;

        await this.storeService.registerStore(
          orgid,
          shopDomain,
          access_token,
          customDomain,
          shopDomains,
          {
            status: tokenData.status,
            plan: tokenData.plan,
            installedAt: tokenData.installed_at,
            expiresAt: tokenData.expires_at,
          },
        );
        await this.saveShopOrgIndex(orgid, shopDomains);
        this.logger.log(
          `Store registered for order lookup: ${orgid} (${shopDomain})`,
        );
      } catch (storeError) {
        this.logger.warn(
          `Store registration failed: ${getErrorMessage(storeError)}`,
        );
      }

      this.logger.log(`App installed for orgid: ${orgid}`);
      await this.notificationService?.notify('APP_INSTALLED', {
        orgid,
        status: tokenData.status,
        plan: tokenData.plan,
      });

      res.redirect(
        this.buildSessionRedirectUrl(
          this.buildSessionResponse(orgid, '/install/login', {
            installed: '1',
          }),
        ),
      );
    } catch (error) {
      this.logger.error(`Install error: ${getErrorMessage(error)}`);
      res.redirect(`${c.frontEndUrl}/install/login?error=install_failed`);
    }
  }

  // ─── Token Refresh ───

  private async getSubscriptionSnapshot(
    orgid: string,
  ): Promise<SubscriptionSnapshot | null> {
    const cached = await this.redisService.get<SubscriptionSnapshot>(
      this.subscriptionKey(orgid),
    );
    if (cached) return cached;

    const stored = await this.db?.findSubscriptionSnapshot(orgid);
    if (!stored) return null;

    const snapshot: SubscriptionSnapshot = {
      orgid: stored.orgid,
      status: stored.status,
      plan: stored.plan,
      is_active: stored.is_active,
      expires_at: stored.expires_at,
      synced_at: stored.synced_at,
      subscription_payload: stored.subscription_payload,
    };
    await this.redisService.set(this.subscriptionKey(orgid), snapshot);
    return snapshot;
  }

  private proQuota(): number {
    const quota =
      Number(this.config.get<string>('ORDER_LOOKUP_QUOTA_PER_SHOP')) || 500;
    return Number.isFinite(quota) && quota > 0 ? quota : 500;
  }

  private async subscribeWebhooks(accessToken: string): Promise<void> {
    const webhookUrl = String(
      this.config.get<string>('HRV_WEBHOOK_URL') || '',
    ).trim();
    if (!webhookUrl || !this.shouldAutoSubscribeWebhook()) return;

    try {
      await axios.post(
        'https://webhook.haravan.com/api/subscribe',
        {
          webhook_url: webhookUrl,
          topics: ['app_subscriptions/update'],
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 8000,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Webhook subscribe endpoint failed, trying legacy endpoint: ${getErrorMessage(error)}`,
      );
      try {
        await axios.post(
          'https://apis.haravan.com/com/webhooks.json',
          {
            webhook: {
              topic: 'app_subscriptions/update',
              address: webhookUrl,
              format: 'json',
            },
          },
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 8000,
          },
        );
      } catch (legacyError) {
        this.logger.warn(
          `Webhook subscribe skipped: ${getErrorMessage(legacyError)}`,
        );
      }
    }
  }

  verifyWebhookChallenge(query: Record<string, unknown>): string {
    const token = asString(query['hub.verify_token']);
    const challenge = asString(query['hub.challenge']);
    const expected = String(
      this.config.get<string>('HRV_WEBHOOK_SECRET') || '',
    ).trim();
    if (!expected || token !== expected || !challenge) {
      throw new UnauthorizedException('Invalid webhook challenge');
    }
    return challenge;
  }

  async handleWebhook(req: RawBodyRequest): Promise<Record<string, unknown>> {
    const topic =
      this.getHeaderValue(req, ['x-haravan-topic', 'X-Haravan-Topic']) || '';
    if (!this.verifyWebhookHmac(req)) {
      this.logger.warn(
        `Rejected webhook with invalid HMAC: ${topic || 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid webhook hmac');
    }

    if (topic.toLowerCase() !== 'app_subscriptions/update') {
      await this.db?.recordWebhook({
        topic: topic || 'unknown',
        payload: req.body,
        headers: this.pickWebhookHeaders(req),
        status: 'ignored',
      });
      return { ok: true, ignored: true, topic };
    }

    return this.syncSubscriptionFromWebhook(req, topic);
  }

  private verifyWebhookHmac(req: RawBodyRequest): boolean {
    const rawBody = req.rawBody;
    if (!rawBody?.length) return false;

    const signature = this.getHeaderValue(req, [
      'x-haravan-hmacsha256',
      'x-haravan-hmac-sha256',
      'x-haravan-hmac',
    ]);
    if (!signature) return false;

    const actual = /^[a-f0-9]{64}$/i.test(signature)
      ? Buffer.from(signature, 'hex')
      : Buffer.from(signature, 'base64');

    return this.getWebhookHmacSecrets().some((secret) => {
      const computed = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest();
      return (
        actual.length === computed.length &&
        crypto.timingSafeEqual(actual, computed)
      );
    });
  }

  private getHeaderValue(req: Request, names: string[]): string | null {
    for (const name of names) {
      const value = req.headers[name.toLowerCase()];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0].trim();
      }
    }
    return null;
  }

  private async syncSubscriptionFromWebhook(
    req: RawBodyRequest,
    topic: string,
  ): Promise<Record<string, unknown>> {
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const subscription = this.getSubscriptionPayload(body);
    const orgid = await this.resolveWebhookOrgid(req, body, subscription);
    if (!orgid) throw new BadRequestException('Missing orgid');

    const now = Date.now();
    const status = this.normalizeSubscriptionStatus(subscription);
    const expiresAt = this.getSubscriptionExpiresAt(subscription);
    const active = this.isSubscriptionActive(subscription, status, expiresAt);
    const snapshot: SubscriptionSnapshot = {
      orgid,
      status: active ? 'active' : status,
      plan: active ? 'Pro' : 'Free',
      is_active: active,
      expires_at: active
        ? expiresAt || Date.now() + DEFAULT_PRO_EXPIRES_MS
        : expiresAt,
      synced_at: now,
      subscription_payload: subscription,
    };

    await this.redisService.set(this.subscriptionKey(orgid), snapshot);
    await this.db?.upsertSubscription({
      orgid,
      status: snapshot.status,
      plan: snapshot.plan,
      isActive: snapshot.is_active,
      expiresAt: snapshot.expires_at,
      syncedAt: snapshot.synced_at,
      payload: snapshot.subscription_payload,
    });

    const appData = await this.getInstallSession(orgid);
    if (appData) {
      const quota = this.proQuota();
      const updated: RedisInstallData = {
        ...appData,
        status: snapshot.status,
        plan: snapshot.plan,
        expires_at: snapshot.expires_at || appData.expires_at,
        subscription_status: snapshot.status,
        subscription_updated_at: now,
        subscription_payload: subscription,
        quota_total: active
          ? appData.quota_total || quota
          : appData.quota_total,
        quota_remaining: active
          ? (appData.quota_remaining ?? appData.quota_total ?? quota)
          : appData.quota_remaining,
      };
      await this.saveInstallSession(orgid, updated);
      await this.syncStoreFromInstallData(orgid, updated);
    }

    await this.notificationService?.notify('APP_SUBSCRIPTION_UPDATE', {
      orgid,
      status: snapshot.status,
      plan: snapshot.plan,
      expires_at: snapshot.expires_at,
    });
    await this.db?.recordWebhook({
      topic,
      orgid,
      payload: body,
      headers: this.pickWebhookHeaders(req),
      status: 'processed',
    });
    this.logger.log(`Subscription synced for orgid=${orgid}`);
    return { ok: true, topic, orgid, subscription: snapshot };
  }

  private pickWebhookHeaders(req: Request): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    [
      'x-haravan-topic',
      'x-haravan-org-id',
      'x-haravan-orgid',
      'x-haravan-shop-domain',
      'x-shop-domain',
      'x-haravan-domain',
      'user-agent',
    ].forEach((name) => {
      const value = req.headers[name];
      if (value !== undefined) picked[name] = value;
    });
    return picked;
  }

  private getSubscriptionPayload(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const direct =
      body.app_subscription ||
      body.subscription ||
      body.appSubscription ||
      body;
    return typeof direct === 'object' && direct !== null
      ? (direct as Record<string, unknown>)
      : body;
  }

  private async resolveWebhookOrgid(
    req: RawBodyRequest,
    body: Record<string, unknown>,
    subscription: Record<string, unknown>,
  ): Promise<string | null> {
    const query = req.query as Record<string, unknown>;
    const shop =
      typeof body.shop === 'object' && body.shop !== null
        ? (body.shop as Record<string, unknown>)
        : undefined;
    const resource =
      typeof body.resource === 'object' && body.resource !== null
        ? (body.resource as Record<string, unknown>)
        : {};
    const candidates = [
      this.getHeaderValue(req, ['x-haravan-org-id', 'x-haravan-orgid']),
      asString(query.orgid),
      asString(query.org_id),
      asString(body.orgid),
      asString(body.org_id),
      asString(body.organization_id),
      asString(body.shop_id),
      asString(shop?.id),
      asString(subscription.orgid),
      asString(subscription.org_id),
      asString(subscription.organization_id),
      asString(subscription.shop_id),
    ];
    const directOrgid = candidates.find(Boolean);
    if (directOrgid) return directOrgid;

    const shopCandidates = [
      asString(query.shop),
      asString(query.shop_domain),
      this.getHeaderValue(req, [
        'x-haravan-shop-domain',
        'x-shop-domain',
        'x-haravan-shop',
        'x-shop',
        'x-haravan-domain',
      ]),
      typeof body.shop === 'string' ? body.shop : null,
      asString(body.shop_domain),
      asString(body.domain),
      asString(body.shop_url),
      asString(body.orgsub),
      asString(shop?.domain),
      asString(shop?.shop_domain),
      asString(shop?.myharavan_domain),
      asString(subscription.shop_domain),
      asString(subscription.domain),
      asString(subscription.shop),
      asString(subscription.shop_url),
      asString(subscription.orgsub),
      asString(resource.shop_domain),
      asString(resource.domain),
      asString(resource.shop),
      asString(resource.shop_url),
      asString(resource.orgsub),
    ].filter(Boolean) as string[];

    for (const candidate of shopCandidates) {
      const resolved = await this.resolveOrgidFromShop(candidate);
      if (resolved) return resolved;
    }

    return null;
  }

  private normalizeSubscriptionStatus(
    subscription: Record<string, unknown>,
  ): string {
    const raw = (
      asString(subscription.status) ||
      asString(subscription.state) ||
      asString(subscription.subscription_status) ||
      ''
    ).toLowerCase();
    const map: Record<string, string> = {
      active: 'active',
      accepted: 'accepted',
      approved: 'approved',
      cancelled: 'canceled',
      canceled: 'canceled',
      inactive: 'unactive',
      unactive: 'unactive',
    };
    return map[raw] || raw || 'unknown';
  }

  private isSubscriptionActive(
    subscription: Record<string, unknown>,
    status: string,
    expiresAt?: number,
  ): boolean {
    const statusActive = ['active', 'accepted', 'approved'].includes(status);
    const canceledAt = subscription.canceled_at || subscription.cancelled_at;
    const notExpired = !expiresAt || expiresAt > Date.now();
    return statusActive && !canceledAt && notExpired;
  }

  private getSubscriptionExpiresAt(
    subscription: Record<string, unknown>,
  ): number | undefined {
    const keys = [
      'expired_at',
      'expires_at',
      'expire_at',
      'expired_on',
      'expires_on',
      'ends_at',
      'current_period_end',
      'current_period_ends_at',
      'billing_on',
    ];
    for (const key of keys) {
      const parsed = this.parseDateMs(subscription[key]);
      if (parsed) return parsed;
    }
    return undefined;
  }

  private parseDateMs(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    const raw =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string'
          ? value.trim()
          : '';
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw);
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private async syncStoreFromInstallData(
    orgid: string,
    appData: RedisInstallData,
  ): Promise<void> {
    if (!appData.access_token) return;
    const shopDomains = getInstallShopDomains(appData);
    const shopDomain =
      appData.primary_domain ||
      appData.domain ||
      appData.myharavan_domain ||
      `${orgid}.myharavan.com`;
    const customDomain =
      appData.domain && appData.domain !== appData.myharavan_domain
        ? appData.domain
        : undefined;
    await this.storeService.registerStore(
      orgid,
      shopDomain,
      appData.access_token,
      customDomain,
      shopDomains,
      {
        status: appData.status,
        plan: appData.plan,
        installedAt: appData.installed_at,
        expiresAt: appData.expires_at,
      },
    );
    await this.saveShopOrgIndex(orgid, shopDomains);
  }

  async refreshToken(
    orgid: string,
    old_refresh_token: string,
  ): Promise<string> {
    if (!old_refresh_token) throw new UnauthorizedException('No Refresh Token');

    const c = this.getHaravanConfig();
    const params = new URLSearchParams({
      refresh_token: old_refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: c.grantTypeRefresh,
    });

    try {
      const response = await axios.post<OAuthTokenPayload>(
        c.urlConnectToken,
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.data) throw new BadRequestException();
      const { access_token, expires_in, refresh_token } = response.data;
      if (!access_token || !expires_in) {
        throw new BadRequestException('Invalid refresh token payload');
      }
      const tokenExpiresAt = Date.now() + expires_in * 1000;

      const existsApp = await this.getInstallSession(orgid);
      let shopInfoSynced = false;
      let refreshedShopData: Record<string, unknown> = {};
      try {
        refreshedShopData = await this.haravanAPI.getShop(access_token);
        shopInfoSynced = true;
      } catch (shopError) {
        this.logger.warn(
          `Failed to refresh shop domains for orgid ${orgid}: ${getErrorMessage(shopError)}`,
        );
      }
      const refreshedDomains = {
        domain: asString(refreshedShopData.domain) || undefined,
        primary_domain: asString(refreshedShopData.primary_domain) || undefined,
        myharavan_domain:
          asString(refreshedShopData.myharavan_domain) || undefined,
      };
      let savedApp: RedisInstallData;

      if (existsApp) {
        existsApp.access_token = access_token;
        existsApp.refresh_token = refresh_token || existsApp.refresh_token;
        existsApp.token_expires_at = tokenExpiresAt;
        existsApp.haravan_token_status = undefined;
        existsApp.haravan_token_error = undefined;
        existsApp.haravan_token_error_code = undefined;
        existsApp.haravan_token_error_at = undefined;
        if (
          existsApp.status === 'needs_reinstall' &&
          this.isProApp(existsApp)
        ) {
          existsApp.status = 'active';
        }
        if (shopInfoSynced) {
          existsApp.domain = refreshedDomains.domain;
          existsApp.primary_domain = refreshedDomains.primary_domain;
          existsApp.myharavan_domain = refreshedDomains.myharavan_domain;
        }
        savedApp = existsApp;
        await this.saveInstallSession(orgid, existsApp);
      } else {
        savedApp = {
          orgid,
          access_token,
          refresh_token: refresh_token || undefined,
          token_expires_at: tokenExpiresAt,
          status: 'trial',
          ...refreshedDomains,
        };
        await this.saveInstallSession(orgid, savedApp);
      }

      // ─── Sync token to Order Lookup store record ───
      try {
        const store = await this.storeService.getStoreByOrgId(orgid);
        const syncedDomains = getInstallShopDomains(savedApp);
        const extraDomains =
          shopInfoSynced && syncedDomains.length
            ? syncedDomains
            : store?.shop_domains || [];
        const shopDomain =
          savedApp.primary_domain ||
          savedApp.domain ||
          savedApp.myharavan_domain ||
          store?.shop_domain ||
          `${orgid}.myharavan.com`;
        const customDomain =
          savedApp.domain && savedApp.domain !== savedApp.myharavan_domain
            ? savedApp.domain
            : store?.custom_domain;

        await this.storeService.registerStore(
          orgid,
          shopDomain,
          access_token,
          customDomain,
          extraDomains,
          {
            status: savedApp.status,
            plan: savedApp.plan,
            installedAt: savedApp.installed_at,
            expiresAt: savedApp.expires_at,
          },
        );
        if (syncedDomains.length) {
          await this.saveShopOrgIndex(orgid, syncedDomains);
        }
      } catch {
        /* non-critical */
      }

      this.logger.log(
        `Token refreshed for orgid=${orgid}, expires in ${expires_in}s`,
      );
      return access_token;
    } catch (error) {
      this.logger.error(`Token refresh error: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
