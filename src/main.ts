import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { AppModule } from './app.module';
import { NotificationService } from './notification/notification.service';
import { TelegramExceptionFilter } from './notification/telegram-exception.filter';

type RawBodyRequest = Request & { rawBody?: Buffer; rawBodyText?: string };

const captureRawBody = (
  req: RawBodyRequest,
  _res: Response,
  buf: Buffer,
): void => {
  if (!buf?.length) return;
  req.rawBody = Buffer.from(buf);
  req.rawBodyText = buf.toString('utf8');
};

const parseOrigins = (value?: string): string[] =>
  String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const parseTrustProxy = (value?: string): boolean | number | string => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = Number(raw);
  return Number.isInteger(asNumber) && asNumber >= 0 ? asNumber : raw;
};

const requireEnv = (
  config: ConfigService,
  keys: string[],
  logger: Logger,
): void => {
  const missing = keys.filter(
    (key) => !String(config.get<string>(key) || '').trim(),
  );
  if (!missing.length) return;
  logger.error(`Missing required production env: ${missing.join(', ')}`);
  throw new Error(`Missing required production env: ${missing.join(', ')}`);
};

const CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Origin',
  'Referer',
  'X-Requested-With',
  'X-Orgid',
  'Orgid',
  'X-Shop-Domain',
  'X-Store-Origin',
  'X-Haravan-Hmac',
  'X-Haravan-HmacSha256',
  'X-Haravan-Topic',
  'Ngrok-Skip-Browser-Warning',
].join(', ');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);
  const notificationService = app.get(NotificationService, { strict: false });
  const isProduction =
    String(configService.get<string>('NODE_ENV') || '').toLowerCase() ===
    'production';
  const trustProxy = parseTrustProxy(configService.get<string>('TRUST_PROXY'));
  const expressInstance = app.getHttpAdapter().getInstance() as {
    set(name: string, value: boolean | number | string): void;
  };
  expressInstance.set('trust proxy', trustProxy);

  if (isProduction) {
    requireEnv(
      configService,
      [
        'FRONTEND_URL',
        'API_BASE_URL',
        'WIDGET_API_URL',
        'REDIS_HOST',
        'HRV_URL_AUTHORIZE',
        'HRV_URL_CONNECT_TOKEN',
        'HRV_CLIENT_ID',
        'HRV_CLIENT_SECRET',
        'HRV_LOGIN_CALLBACK_URL',
        'HRV_INSTALL_CALLBACK_URL',
        'APP_SESSION_SECRET',
        'LOOKUP_HASH_SECRET',
      ],
      logger,
    );
    if (String(configService.get<string>('DATABASE_URL') || '').trim()) {
      requireEnv(configService, ['DATA_ENCRYPTION_KEY'], logger);
    }
    if (
      String(configService.get<string>('HRV_WEBHOOK_URL') || '').trim() ||
      String(configService.get<string>('HRV_WEBHOOK_AUTO_SUBSCRIBE') || '')
        .trim()
        .toLowerCase() === 'true'
    ) {
      requireEnv(configService, ['HRV_WEBHOOK_SECRET'], logger);
    }
  }

  const webhookBodyLimit =
    configService.get<string>('WEBHOOK_BODY_LIMIT') || '256kb';
  const requestBodyLimit =
    configService.get<string>('REQUEST_BODY_LIMIT') || '1mb';
  app.use(
    '/api/oauth/install/webhooks',
    express.json({ limit: webhookBodyLimit, verify: captureRawBody }),
    express.urlencoded({
      limit: webhookBodyLimit,
      extended: true,
      verify: captureRawBody,
    }),
  );
  app.use(express.json({ limit: requestBodyLimit, verify: captureRawBody }));
  app.use(
    express.urlencoded({
      limit: requestBodyLimit,
      extended: true,
      verify: captureRawBody,
    }),
  );

  const allowedOrigins = [
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'http://127.0.0.1',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
    process.env.FRONTEND_URL,
    process.env.API_BASE_URL,
    process.env.WIDGET_PUBLIC_URL,
    process.env.WIDGET_API_URL,
    ...parseOrigins(process.env.CORS_ALLOWED_ORIGINS),
  ].filter((origin): origin is string => Boolean(origin));

  const isAllowedOrigin = (origin: string): boolean => {
    if (allowedOrigins.includes(origin)) return true;
    try {
      const { hostname } = new URL(origin);
      if (
        process.env.NODE_ENV !== 'production' &&
        (hostname === 'localhost' || hostname === '127.0.0.1')
      ) {
        return true;
      }
      return hostname === 'f1genz.com' || hostname.endsWith('.f1genz.com');
    } catch {
      return false;
    }
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.setHeader('Vary', 'Origin');
    } else if (typeof origin === 'string') {
      logger.warn(`Blocked CORS origin: ${origin}`);
    }

    if (req.method === 'OPTIONS') {
      res.status(
        typeof origin === 'string' && !isAllowedOrigin(origin) ? 403 : 204,
      );
      res.end();
      return;
    }

    next();
  });

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('X-Powered-By');
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(
    new TelegramExceptionFilter(notificationService, configService),
  );

  const port = process.env.PORT || 3333;
  await app.listen(port);
  logger.log(`Server running on port ${port}`);
}
void bootstrap();
