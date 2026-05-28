import {
  Controller,
  Get,
  Put,
  Body,
  UsePipes,
  UseGuards,
  ValidationPipe,
  BadRequestException,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ShopAuthGuard } from '../../common/guards/shop-auth.guard';
import {
  AllowExpiredHaravanToken,
  ShopOrgId,
} from '../../common/decorators/shop-auth.decorator';
import { StoreService } from '../services/store.service';
import type { StoreRecord } from '../services/store.service';
import { UpdateStoreSettingsDto } from '../dto/store-settings.dto';
import { HaravanService } from '../../haravan/haravan.service';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../database/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

const LOG_PREFIX = 'haravan:checkorders:log';
const TELEMETRY_PREFIX = 'haravan:checkorders:telemetry';

const widgetApiUrl = (): string =>
  (process.env.WIDGET_API_URL || '').replace(/\/+$/, '');

const publicShopIdentifier = (store: StoreRecord): string => {
  const domain = String(store.shop_domain || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  return domain.endsWith('.myharavan.com')
    ? domain.slice(0, -'.myharavan.com'.length)
    : domain;
};

const addDaysIso = (value: string | undefined, days: number): string => {
  const base = value ? new Date(value) : new Date();
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  safeBase.setDate(safeBase.getDate() + days);
  return safeBase.toISOString();
};

const planFromStatus = (status: string | undefined): string => {
  const normalized = String(status || 'trial').toLowerCase();
  if (['active', 'accepted', 'approved'].includes(normalized)) return 'Pro';
  if (normalized === 'trial') return 'Trial';
  return 'Free';
};

/**
 * AdminController — settings and widget preview for merchants.
 * Protected by ShopAuthGuard — requires valid orgid with active token.
 */
@Controller('order-admin')
@UseGuards(ShopAuthGuard)
export class AdminController {
  constructor(
    private readonly storeService: StoreService,
    @Inject(forwardRef(() => HaravanService))
    private readonly haravanService: HaravanService,
    private readonly redis: RedisService,
    @Optional()
    private readonly db?: PrismaService,
  ) {}

  /**
   * GET /api/order-admin/settings?orgid=xxx
   */
  @Get('settings')
  async getSettings(@ShopOrgId() orgId: string) {
    if (!orgId) throw new BadRequestException('Missing orgid');

    const store = await this.storeService.getStoreByOrgId(orgId);
    if (!store) throw new BadRequestException('Store not found');

    const settings = await this.storeService.getSettings(orgId);

    return {
      success: true,
      settings,
      store_info: {
        shop_domain: store.shop_domain,
        public_shop: publicShopIdentifier(store),
        installed_at: store.installed_at,
        expires_at: store.expires_at || addDaysIso(store.installed_at, 15),
        status: store.status || 'trial',
        plan: store.plan || planFromStatus(store.status),
        is_active: store.is_active,
      },
    };
  }

  /**
   * PUT /api/order-admin/settings?orgid=xxx
   */
  @Put('settings')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async updateSettings(
    @ShopOrgId() orgId: string,
    @Body() body: UpdateStoreSettingsDto,
  ) {
    if (!orgId) throw new BadRequestException('Missing orgid');

    const store = await this.storeService.getStoreByOrgId(orgId);
    if (!store) throw new BadRequestException('Store not found');

    const updated = await this.storeService.updateSettings(orgId, body);
    return { success: true, settings: updated };
  }

  /**
   * GET /api/order-admin/health?orgid=xxx
   */
  @Get('health')
  @AllowExpiredHaravanToken()
  async getHealth(@ShopOrgId() orgId: string) {
    if (!orgId) throw new BadRequestException('Missing orgid');

    const store = await this.storeService.getStoreByOrgId(orgId);
    if (!store) throw new BadRequestException('Store not found');

    const settings = await this.storeService.getSettings(orgId);
    const publicShop = publicShopIdentifier(store);
    const widgetBase = widgetApiUrl();
    const widgetUrl = `${widgetBase}/api/order/widget/shop/${encodeURIComponent(
      publicShop,
    )}`;

    let redisStatus: 'ok' | 'error' = 'ok';
    try {
      await this.redis.ping();
    } catch {
      redisStatus = 'error';
    }
    const databaseStatus = (await this.db?.ping()) || 'disabled';

    const lookupLogs =
      (await this.redis.get<unknown[]>(`${LOG_PREFIX}:${orgId}:global`)) || [];
    const lookupTelemetry =
      (await this.redis.get<Record<string, unknown>>(
        `${TELEMETRY_PREFIX}:${orgId}:last`,
      )) || null;

    return {
      success: true,
      health: {
        redis: redisStatus,
        database: databaseStatus,
        store: {
          shop_domain: store.shop_domain,
          public_shop: publicShop,
          is_active: store.is_active,
          status: store.status || 'trial',
          plan: store.plan || planFromStatus(store.status),
          installed_at: store.installed_at,
          expires_at: store.expires_at || addDaysIso(store.installed_at, 15),
        },
        widget: {
          enabled: settings.widget_enabled !== false,
          display_mode: settings.widget_display_mode || 'inline',
          lookup_method: settings.lookup_method,
          max_orders: settings.max_orders,
          inline_url: widgetUrl,
          popup_script_url: `${widgetUrl}/embed.js`,
        },
        connection: await this.haravanService.getConnectionHealth(orgId, true),
        lookup: {
          last_log: Array.isArray(lookupLogs) ? lookupLogs[0] || null : null,
          telemetry: lookupTelemetry,
        },
      },
    };
  }

  /**
   * GET /api/order-admin/reconnect?orgid=xxx
   */
  @Get('reconnect')
  @AllowExpiredHaravanToken()
  async reconnect(@ShopOrgId() orgId: string) {
    if (!orgId) throw new BadRequestException('Missing orgid');
    return {
      success: true,
      ...(await this.haravanService.buildReconnectUrl()),
    };
  }

  /**
   * GET /api/order-admin/widget-html?orgid=xxx
   */
  @Get('widget-html')
  async getWidgetHtml(@ShopOrgId() orgId: string) {
    if (!orgId) throw new BadRequestException('Missing orgid');

    const store = await this.storeService.getStoreByOrgId(orgId);
    if (!store) throw new BadRequestException('Store not found');

    const widgetPath = path.join(
      __dirname,
      '..',
      'widget',
      'order-lookup.liquid',
    );
    let html = '';
    try {
      html = fs.readFileSync(widgetPath, 'utf-8');
    } catch {
      const srcPath = path.resolve(
        process.cwd(),
        'src/order-lookup/widget/order-lookup.liquid',
      );
      html = fs.readFileSync(srcPath, 'utf-8');
    }

    html = html.replace(
      /\{\{\s*settings\.f1g_order_api_url\s*\|\s*default:\s*'[^']*'\s*\}\}/g,
      widgetApiUrl(),
    );
    html = html.replace(
      /\{\{\s*settings\.f1g_order_shop\s*\|\s*default:\s*'[^']*'\s*\}\}/g,
      publicShopIdentifier(store),
    );

    const fullHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>html,body{margin:0;padding:0;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}</style>
</head>
<body>
<script>window.__f1gConfig=${JSON.stringify({
      preview_enabled: true,
      public_shop: publicShopIdentifier(store),
    })};</script>
${html}
</body>
</html>`;

    return { success: true, html: fullHtml };
  }
}
