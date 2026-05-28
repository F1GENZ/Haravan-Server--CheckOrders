import { Module, forwardRef } from '@nestjs/common';
import { HaravanController } from './haravan.controller';
import { HaravanService } from './haravan.service';
import { HaravanAPIService } from './haravan.api';
import { HaravanCronService } from './haravan.cron';
import { OrderLookupModule } from '../order-lookup/order-lookup.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [forwardRef(() => OrderLookupModule), NotificationModule],
  controllers: [HaravanController],
  providers: [HaravanService, HaravanAPIService, HaravanCronService],
  exports: [HaravanService, HaravanAPIService],
})
export class HaravanModule {}
