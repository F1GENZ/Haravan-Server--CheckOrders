import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { NotificationService } from './notification.service';

const firstHeader = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const getErrorMessage = (exception: unknown): string | string[] => {
  if (exception instanceof HttpException) {
    const payload = exception.getResponse();
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const message = (payload as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String);
    }
    return exception.message;
  }
  if (exception instanceof Error) return exception.message;
  return 'Internal server error';
};

@Catch()
export class TelegramExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Nest maps only `HttpException`, `SyntaxError` and `URIError` itself. body-parser throws `http-errors` objects
   * (413 `request entity too large`, 415, 400 on a bad charset) that are plain `Error`s carrying a 4xx
   * `status`; without this they answer 500 and page Telegram for a client mistake.
   */
  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception instanceof Error && Reflect.get(exception, 'expose') === true) {
      for (const key of ['status', 'statusCode']) {
        const candidate: unknown = Reflect.get(exception, key);
        if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate < 500) {
          return candidate;
        }
      }
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { orgid?: string }>();
    const res = ctx.getResponse<Response>();
    const status = this.statusOf(exception);
    const notify4xx =
      String(
        this.configService.get<string>('TELEGRAM_NOTIFY_HTTP_4XX') || '',
      ).toLowerCase() === 'true';

    if (status >= 500 || notify4xx) {
      // A failing alert channel must never turn a handled error into an unhandled rejection.
      void this.notificationService
        .notifyError('HTTP_EXCEPTION', exception, {
          status,
          method: req.method,
          path: (req.originalUrl || req.url).split('?')[0],
          orgid: req.orgid || firstHeader(req.headers['x-orgid']),
          origin: firstHeader(req.headers.origin),
          referer: firstHeader(req.headers.referer)?.split('?')[0],
        })
        .catch(() => undefined);
    }

    if (res.headersSent) return;

    res.status(status).json({
      statusCode: status,
      message: getErrorMessage(exception),
      path: req.originalUrl || req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
