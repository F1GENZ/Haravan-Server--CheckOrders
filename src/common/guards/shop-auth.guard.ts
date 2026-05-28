import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { HaravanService } from '../../haravan/haravan.service';
import { ALLOW_EXPIRED_HARAVAN_TOKEN } from '../decorators/shop-auth.decorator';

type ShopRequest = Request<
  Record<string, string>,
  unknown,
  Record<string, unknown>,
  Record<string, unknown>
> & {
  orgid?: string;
  token?: string;
  haravanTokenExpired?: boolean;
  haravanTokenSuspicious?: boolean;
};

const ORGID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const toStringValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0];
  }
  return null;
};

@Injectable()
export class ShopAuthGuard implements CanActivate {
  constructor(
    private readonly haravanService: HaravanService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  private getBearerToken(req: ShopRequest): string | null {
    const authorization = req.headers.authorization;
    const rawHeader =
      typeof authorization === 'string'
        ? authorization
        : Array.isArray(authorization) && typeof authorization[0] === 'string'
          ? authorization[0]
          : null;
    if (!rawHeader) return null;

    const [scheme, token] = rawHeader.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }

  private getCookieValue(req: ShopRequest, name: string): string | null {
    const rawCookie = toStringValue(req.headers.cookie);
    if (!rawCookie) return null;

    const encodedName = `${encodeURIComponent(name)}=`;
    for (const part of rawCookie.split(/;\s*/)) {
      if (!part.startsWith(encodedName)) continue;
      try {
        return decodeURIComponent(part.slice(encodedName.length));
      } catch {
        return part.slice(encodedName.length);
      }
    }
    return null;
  }

  private getSessionToken(req: ShopRequest): string | null {
    return (
      this.getBearerToken(req) || this.getCookieValue(req, 'auth_session_token')
    );
  }

  private getRequestedOrgid(req: ShopRequest): string | null {
    return (
      toStringValue(req.headers['x-orgid']) ||
      toStringValue(req.headers.orgid) ||
      toStringValue(req.query?.orgid) ||
      toStringValue(req.body?.orgid)
    );
  }

  private getHostFromUrl(value: string | null): string | null {
    if (!value) return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private getAllowedAdminHosts(req: ShopRequest): Set<string> {
    const hosts = [
      toStringValue(req.headers.host),
      toStringValue(req.headers['x-forwarded-host']),
      this.getHostFromUrl(process.env.FRONTEND_URL || null),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.split(':')[0].toLowerCase());
    return new Set(hosts);
  }

  private assertTrustedOrigin(req: ShopRequest): void {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return;

    const originHost =
      this.getHostFromUrl(toStringValue(req.headers.origin)) ||
      this.getHostFromUrl(toStringValue(req.headers.referer));
    if (!originHost || !this.getAllowedAdminHosts(req).has(originHost)) {
      throw new UnauthorizedException('Untrusted request origin');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ShopRequest>();
    this.assertTrustedOrigin(req);

    const requestedOrgid = this.getRequestedOrgid(req);
    if (requestedOrgid && !ORGID_REGEX.test(requestedOrgid)) {
      throw new BadRequestException('Invalid orgid');
    }

    const sessionToken = this.getSessionToken(req);
    if (!sessionToken) throw new UnauthorizedException('Missing auth session');

    const session = this.haravanService.verifySessionToken(sessionToken);
    if (requestedOrgid && session.orgid !== requestedOrgid) {
      throw new UnauthorizedException('Orgid does not match auth session');
    }
    if (!ORGID_REGEX.test(session.orgid)) {
      throw new BadRequestException('Invalid orgid');
    }

    let accessToken = '';
    try {
      accessToken = await this.haravanService.resolveAccessToken(session.orgid);
    } catch (error) {
      const allowExpiredHaravanToken =
        this.reflector?.getAllAndOverride<boolean>(
          ALLOW_EXPIRED_HARAVAN_TOKEN,
          [context.getHandler(), context.getClass()],
        ) || false;
      if (!allowExpiredHaravanToken) throw error;
      req.haravanTokenExpired = true;
      req.haravanTokenSuspicious = true;
    }

    req.orgid = session.orgid;
    req.token = accessToken;
    return true;
  }
}
