import { Controller, Get, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../database/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Optional()
    private readonly db?: PrismaService,
  ) {}

  @Get()
  async health() {
    let redisStatus: 'ok' | 'error' = 'ok';
    try {
      await this.redis.ping();
    } catch {
      redisStatus = 'error';
    }
    const databaseStatus = (await this.db?.ping()) || 'disabled';

    return {
      ok: redisStatus === 'ok' && databaseStatus !== 'error',
      app: this.config.get<string>('TELEGRAM_APP_NAME') || 'F1GENZ Check Order',
      env: this.config.get<string>('NODE_ENV') || 'development',
      uptime_seconds: Math.round(process.uptime()),
      services: {
        redis: redisStatus,
        database: databaseStatus,
      },
      build_time:
        this.config.get<string>('BUILD_TIME') ||
        this.config.get<string>('SOURCE_VERSION') ||
        '',
      timestamp: new Date().toISOString(),
    };
  }
}
