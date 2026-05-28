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

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { orgid?: string }>();
    const res = ctx.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const notify4xx =
      String(
        this.configService.get<string>('TELEGRAM_NOTIFY_HTTP_4XX') || '',
      ).toLowerCase() === 'true';

    if (status >= 500 || notify4xx) {
      void this.notificationService.notifyError('HTTP_EXCEPTION', exception, {
        status,
        method: req.method,
        path: req.originalUrl || req.url,
        orgid: req.orgid || firstHeader(req.headers['x-orgid']),
        origin: firstHeader(req.headers.origin),
        referer: firstHeader(req.headers.referer),
      });
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
