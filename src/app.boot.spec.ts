jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client');
  class FakePrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    $queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  }
  return { ...actual, PrismaClient: FakePrismaClient };
});

import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';

describe('Redis module boot', () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = originalKey;
  });

  it('resolves RedisService with the config-derived token key through Nest DI', async () => {
    process.env.DATA_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RedisModule,
      ],
    })
      .overrideProvider('REDIS_CLIENT')
      .useValue(client)
      .compile();

    const service = moduleRef.get(RedisService);
    expect(service).toBeInstanceOf(RedisService);
    expect(
      (service as unknown as { tokenKey: Buffer | null }).tokenKey,
    ).toHaveLength(32);
    await expect(service.get('missing')).resolves.toBeNull();
    await moduleRef.close();
  });
});

describe('AppModule boot', () => {
  // The overrides below are the only network edges: the Redis socket and the Prisma connection.
  const fakeEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://boot-test:boot-test@127.0.0.1:1/boot_test',
    DATA_ENCRYPTION_KEY: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    LOOKUP_HASH_SECRET: 'boot-test-lookup-hash-secret',
    APP_SESSION_SECRET: 'boot-test-session-secret',
    FRONTEND_URL: 'https://app.boot-test.invalid',
    API_BASE_URL: 'https://api.boot-test.invalid',
    WIDGET_API_URL: 'https://api.boot-test.invalid',
    REDIS_HOST: '127.0.0.1',
    HRV_URL_AUTHORIZE: 'https://accounts.boot-test.invalid/connect/authorize',
    HRV_URL_CONNECT_TOKEN: 'https://accounts.boot-test.invalid/connect/token',
    HRV_CLIENT_ID: 'boot-test-client',
    HRV_CLIENT_SECRET: 'boot-test-client-secret',
    TELEGRAM_ALERT_ENABLED: 'false',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
  };
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication | undefined;

  beforeEach(() => {
    for (const [key, value] of Object.entries(fakeEnv)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of Object.keys(fakeEnv)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('compiles the real AppModule graph, initialises and closes with the network clients stubbed', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('REDIS_CLIENT')
      .useValue(redis)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const prisma = app.get(PrismaService);
    expect(prisma.enabled).toBe(true);
    expect(app.get(RedisService)).toBeInstanceOf(RedisService);
    expect(prisma.client?.$connect).toHaveBeenCalledTimes(1);

    await app.close();
    app = undefined;
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(prisma.client?.$disconnect).toHaveBeenCalledTimes(1);
  });
});
