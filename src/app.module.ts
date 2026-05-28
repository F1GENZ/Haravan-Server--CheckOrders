import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { HaravanModule } from './haravan/haravan.module';
import { OrderLookupModule } from './order-lookup/order-lookup.module';
import { NotificationModule } from './notification/notification.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    NotificationModule,
    HealthModule,
    HaravanModule,
    OrderLookupModule,
  ],
})
export class AppModule {}
