import type { NextFunction, Request, Response } from 'express';
import { OrderLookupCorsMiddleware } from './cors.middleware';
import type { StoreService } from '../services/store.service';

const ENV_KEYS = [
  'FRONTEND_URL',
  'API_BASE_URL',
  'WIDGET_PUBLIC_URL',
  'WIDGET_API_URL',
  'CORS_ALLOWED_ORIGINS',
];

describe('OrderLookupCorsMiddleware forwarded host', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.CORS_ALLOWED_ORIGINS = 'https://pages.example.test';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const run = async (origin: string, forwardedHost: string) => {
    const existsByDomain = jest.fn().mockResolvedValue(false);
    const middleware = new OrderLookupCorsMiddleware({
      existsByDomain,
    } as unknown as StoreService);
    const json = jest.fn();
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json,
      end: jest.fn(),
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;
    const req = {
      method: 'POST',
      headers: { origin, 'x-forwarded-host': forwardedHost },
    } as unknown as Request;
    await middleware.use(req, res, next);
    return { res, json, next };
  };

  it('denies an origin that only matches an attacker-supplied X-Forwarded-Host', async () => {
    const { res, json, next } = await run(
      'https://evil.example',
      'evil.example',
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'cors_denied' });
    expect(next).not.toHaveBeenCalled();
  });

  it('still allows the proxy host that the Pages function forwards', async () => {
    const { res, json, next } = await run(
      'https://pages.example.test',
      'pages.example.test',
    );
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://pages.example.test',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
  });

  it('only believes the first forwarded value', async () => {
    const { res, next } = await run(
      'https://pages.example.test',
      'evil.example, pages.example.test',
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
