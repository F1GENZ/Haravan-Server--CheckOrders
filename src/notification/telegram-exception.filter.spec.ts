import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TelegramExceptionFilter } from './telegram-exception.filter';
import type { NotificationService } from './notification.service';

const run = (exception: unknown) => {
  const notifyError = jest.fn().mockResolvedValue(undefined);
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', originalUrl: '/api/order/lookup', url: '/api/order/lookup', headers: {} }),
      getResponse: () => ({ headersSent: false, status }),
    }),
  } as unknown as ArgumentsHost;
  const config = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
  new TelegramExceptionFilter({ notifyError } as unknown as NotificationService, config).catch(exception, host);
  return { notifyError, status, body: json.mock.calls[0]?.[0] as { statusCode: number; message: unknown } };
};

describe('TelegramExceptionFilter status mapping', () => {
  it('answers a body-parser 413 (http-errors: plain Error with status and expose) as 413 and does not page Telegram', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const { notifyError, status, body } = run(tooLarge);
    expect(status).toHaveBeenCalledWith(413);
    expect(body).toMatchObject({ statusCode: 413, message: 'request entity too large' });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('keeps a real failure as 500 and pages Telegram, also when it carries a status without http-errors `expose` (an upstream client error)', () => {
    const failures = [
      new Error('db down'),
      Object.assign(new Error('upstream'), { status: 502 }),
      Object.assign(new Error('upstream 404'), { status: 404 }),
    ];
    for (const failure of failures) {
      const { notifyError, status } = run(failure);
      expect(status).toHaveBeenCalledWith(500);
      expect(notifyError).toHaveBeenCalledTimes(1);
    }
  });

  it('still honours HttpException statuses', () => {
    const { status, body } = run(new BadRequestException('bad'));
    expect(status).toHaveBeenCalledWith(400);
    expect(body.message).toBe('bad');
  });
});

describe('TelegramExceptionFilter alert payload', () => {
  const runWithRequest = (request: Record<string, unknown>, exception: unknown) => {
    const notifyError = jest.fn().mockResolvedValue(undefined);
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ headersSent: false, status }),
      }),
    } as unknown as ArgumentsHost;
    const config = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    new TelegramExceptionFilter({ notifyError } as unknown as NotificationService, config).catch(exception, host);
    return { notifyError, body: json.mock.calls[0]?.[0] as { path: string } };
  };

  it('drops query strings from the alert path and referer but keeps the response path', () => {
    const url = '/api/oauth/launch?hmac=abc123&timestamp=1730000000&orgid=org_1';
    const { notifyError, body } = runWithRequest(
      {
        method: 'GET',
        originalUrl: url,
        url,
        headers: {
          referer: 'https://shop.example.test/admin?hmac=abc123&token=secret',
          origin: 'https://shop.example.test',
        },
      },
      new Error('boom'),
    );

    expect(notifyError).toHaveBeenCalledTimes(1);
    const context = notifyError.mock.calls[0][2] as Record<string, unknown>;
    expect(context.path).toBe('/api/oauth/launch');
    expect(context.referer).toBe('https://shop.example.test/admin');
    expect(JSON.stringify(context)).not.toContain('abc123');
    expect(JSON.stringify(context)).not.toContain('secret');
    expect(body.path).toBe(url);
  });

  it('handles a missing referer and a url without a query', () => {
    const { notifyError } = runWithRequest(
      { method: 'GET', originalUrl: '/api/health', url: '/api/health', headers: {} },
      new Error('boom'),
    );
    const context = notifyError.mock.calls[0][2] as Record<string, unknown>;
    expect(context.path).toBe('/api/health');
    expect(context.referer).toBeUndefined();
  });
});

describe('TelegramExceptionFilter when the alert channel fails', () => {
  it('still answers the client and leaves no unhandled rejection when notifyError rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const notifyError = jest.fn().mockRejectedValue(new Error('telegram down'));
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const host = {
        switchToHttp: () => ({
          getRequest: () => ({ method: 'POST', originalUrl: '/api/x', url: '/api/x', headers: {} }),
          getResponse: () => ({ headersSent: false, status }),
        }),
      } as unknown as ArgumentsHost;
      const config = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;

      new TelegramExceptionFilter({ notifyError } as unknown as NotificationService, config).catch(
        new Error('boom'),
        host,
      );

      expect(notifyError).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'boom' }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
