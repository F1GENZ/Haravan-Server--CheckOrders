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
