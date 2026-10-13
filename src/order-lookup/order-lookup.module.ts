import {
  Module,
  MiddlewareConsumer,
  NestModule,
  forwardRef,
} from '@nestjs/common';
import { LookupController } from './controllers/lookup.controller';
import { AdminController } from './controllers/admin.controller';
import { StoreService } from './services/store.service';
import { HaravanOrderService } from './services/haravan-order.service';
import { OrderIndexService } from './services/order-index.service';
import { LookupService } from './services/lookup.service';
import { MaskingService } from './services/masking.service';
import { RateLimitService } from './services/rate-limit.service';
import { HaravanModule } from '../haravan/haravan.module';
import { OrderLookupCorsMiddleware } from './middleware/cors.middleware';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';

@Module({
  imports: [forwardRef(() => HaravanModule)],
  controllers: [LookupController, AdminController],
  providers: [
    StoreService,
    OrderIndexService,
    HaravanOrderService,
    LookupService,
    MaskingService,
    RateLimitService,
    ShopAuthGuard,
  ],
  exports: [StoreService, OrderIndexService, HaravanOrderService],
})
export class OrderLookupModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply dynamic CORS only to public widget/lookup endpoints
    consumer
      .apply(OrderLookupCorsMiddleware)
      .forRoutes('order/lookup', 'order/widget/shop/:shop');
  }
}
