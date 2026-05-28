import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { StoreService } from '../services/store.service';

/**
 * Dynamic CORS middleware for order lookup endpoints.
 *
 * - *.myharavan.com → always allowed (all Haravan storefronts are legitimate)
 * - Custom domains  → checked against registered stores in Redis
 * - Store lookup and input validation in the controller/service handle auth
 */
@Injectable()
export class OrderLookupCorsMiddleware implements NestMiddleware {
  private readonly logger = new Logger(OrderLookupCorsMiddleware.name);

  constructor(private readonly storeService: StoreService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;

    // No Origin header (server-to-server, curl, etc.) — allow
    if (!origin) {
      if (req.method === 'POST') {
        res.status(403).json({ success: false, error: 'origin_required' });
        return;
      }
      return next();
    }

    const allowed = await this.isAllowed(origin, req);

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Accept, Authorization, Content-Type, X-Requested-With, X-Shop-Domain, X-Store-Origin, X-Orgid, Orgid',
      );
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '3600');
      res.setHeader('Vary', 'Origin');
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.status(allowed ? 204 : 403).end();
      return;
    }

    if (!allowed) {
      this.logger.warn(`CORS blocked origin: ${origin}`);
      res.status(403).json({ success: false, error: 'cors_denied' });
      return;
    }

    next();
  }

  private async isAllowed(origin: string, req: Request): Promise<boolean> {
    try {
      const url = new URL(origin);
      const hostname = url.hostname.toLowerCase();

      // Localhost — allow in development & when widget iframe is on same server
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return true;
      }

      if (this.getTrustedProxyHosts().has(hostname)) {
        return true;
      }

      if (hostname === this.getForwardedHost(req)) {
        return true;
      }

      // All *.myharavan.com storefronts are trusted
      // Custom domains → check Redis
      return this.storeService.existsByDomain(hostname);
    } catch {
      return false;
    }
  }

  private getTrustedProxyHosts(): Set<string> {
    const hosts = [
      process.env.API_BASE_URL,
      process.env.FRONTEND_URL,
      process.env.WIDGET_PUBLIC_URL,
      process.env.WIDGET_API_URL,
    ]
      .map((value) => this.getHost(value))
      .filter((value): value is string => Boolean(value));
    return new Set(hosts);
  }

  private getHost(value: string | undefined): string | null {
    if (!value) return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private getForwardedHost(req: Request): string | null {
    return this.normalizeHost(req.headers['x-forwarded-host']);
  }

  private normalizeHost(value: unknown): string | null {
    const raw =
      typeof value === 'string'
        ? value
        : Array.isArray(value) && typeof value[0] === 'string'
          ? value[0]
          : '';
    const first = raw.split(',')[0]?.trim();
    if (!first) return null;

    try {
      return new URL(
        /^https?:\/\//i.test(first) ? first : `https://${first}`,
      ).hostname.toLowerCase();
    } catch {
      return first.split(':')[0]?.toLowerCase() || null;
    }
  }
}
