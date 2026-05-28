import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Param,
  Req,
  Res,
  HttpCode,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LookupService } from '../services/lookup.service';
import { StoreService } from '../services/store.service';
import type { StoreRecord } from '../services/store.service';
import { LookupRequestDto } from '../dto/lookup-request.dto';
import type { LookupResponseDto } from '../dto/lookup-response.dto';
import * as fs from 'fs';
import * as path from 'path';

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

const firstHeaderValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
};

const normalizeIp = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  if (!first) return null;
  return first.replace(/^::ffff:/, '');
};

const getClientIp = (req: Request): string => {
  return (
    normalizeIp(req.ip) || normalizeIp(req.socket.remoteAddress) || 'unknown'
  );
};

const getForwardedHost = (req: Request): string | undefined => {
  return (
    firstHeaderValue(req.headers['x-forwarded-host']) ||
    firstHeaderValue(req.headers.host) ||
    undefined
  );
};

@Controller('order')
export class LookupController {
  constructor(
    private readonly lookupService: LookupService,
    private readonly storeService: StoreService,
  ) {}

  /**
   * POST /api/order/lookup
   * Public endpoint called from storefront widget.
   */
  @Post('lookup')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async lookup(
    @Body() body: LookupRequestDto,
    @Headers('x-shop-domain') shopHeader: string,
    @Headers('origin') origin: string,
    @Headers('x-store-origin') storeOrigin: string,
    @Req() req: Request,
  ): Promise<LookupResponseDto> {
    const publicShop = body.shop || shopHeader || storeOrigin;
    if (!publicShop) {
      return {
        success: false,
        error: 'missing_shop',
        message: 'Missing shop',
      };
    }

    return this.lookupService.lookup(
      publicShop,
      body.phone,
      body.order_code,
      getClientIp(req),
      origin,
      storeOrigin,
      body.captcha_token,
      getForwardedHost(req),
    );
  }

  /**
   * GET /api/order/widget/shop/:shop
   * Public widget URL. `shop` can be a Haravan handle or full shop domain.
   */
  @Get('widget/shop/:shop')
  async serveWidgetByShop(@Param('shop') shop: string, @Res() res: Response) {
    const store = await this.storeService.getStoreByPublicShop(shop);
    if (!store) {
      res
        .status(404)
        .send(
          '<html><body><p>Widget not found. Invalid shop.</p></body></html>',
        );
      return;
    }

    return this.sendWidget(store, publicShopIdentifier(store), res);
  }

  /**
   * GET /api/order/widget/shop/:shop/embed.js
   * Compact storefront loader for popup mode. It anchors the iframe to
   * document.body, so the floating button is no longer trapped in page content.
   */
  @Get('widget/shop/:shop/embed.js')
  async serveEmbedScript(@Param('shop') shop: string, @Res() res: Response) {
    const store = await this.storeService.getStoreByPublicShop(shop);
    if (!store) {
      res.status(404).type('application/javascript').send('');
      return;
    }
    const settings = await this.storeService.getSettings(store.org_id);

    const publicShop = publicShopIdentifier(store);
    const widgetPath = `/api/order/widget/shop/${encodeURIComponent(publicShop)}`;
    const frameId = `f1g-order-lookup-${publicShop.replace(/[^a-zA-Z0-9_-]/g, '') || 'widget'}`;
    const widgetUrl = `${widgetApiUrl()}${widgetPath}`;
    const displayMode =
      settings.widget_display_mode === 'trigger' ? 'trigger' : 'popup';
    const triggerAction =
      settings.widget_trigger_action === 'link' ? 'link' : 'modal';
    const triggerLinkUrl = String(settings.widget_trigger_link_url || '').trim();

    const js = `
(function () {
  var frameId = ${JSON.stringify(frameId)};
  var script = document.currentScript;
  var src = new URL(${JSON.stringify(widgetPath)}, script ? script.src : window.location.href).href;
  var widgetUrl = ${JSON.stringify(widgetUrl)};
  var displayMode = ${JSON.stringify(displayMode)};
  var triggerAction = ${JSON.stringify(triggerAction)};
  var triggerLinkUrl = ${JSON.stringify(triggerLinkUrl)};
  if (document.getElementById(frameId)) return;
  var frameLoaded = false;
  var pendingOpen = false;

  var frame = document.createElement("iframe");
  frame.id = frameId;
  frame.src = src;
  frame.title = "Tra cứu đơn hàng";
  frame.loading = "lazy";
  frame.style.cssText = "position:fixed;right:20px;bottom:20px;width:252px;height:96px;border:0;z-index:2147483647;background:transparent;";
  frame.addEventListener("load", function () {
    frameLoaded = true;
    if (pendingOpen) {
      pendingOpen = false;
      postBack(frame.contentWindow, widgetOrigin, { type: "f1g_widget_trigger_open" });
    }
  });
  document.body.appendChild(frame);

  var widgetOrigin;
  try {
    widgetOrigin = new URL(src, window.location.href).origin;
  } catch (e) {
    return;
  }

  function postBack(source, origin, payload) {
    if (source && source.postMessage) source.postMessage(payload, origin);
  }

  function setPopupFrame(open) {
    frame.style.position = "fixed";
    frame.style.border = "0";
    frame.style.zIndex = "2147483647";
    frame.style.background = "transparent";
    if (open) {
      frame.style.display = "block";
      frame.style.pointerEvents = "auto";
      frame.style.opacity = "1";
      frame.style.left = "0";
      frame.style.top = "0";
      frame.style.right = "0";
      frame.style.bottom = "0";
      frame.style.width = "100vw";
      frame.style.height = "100vh";
    } else {
      if (displayMode === "trigger") {
        frame.style.display = "block";
        frame.style.pointerEvents = "none";
        frame.style.opacity = "0";
        frame.style.left = "auto";
        frame.style.top = "auto";
        frame.style.right = "0";
        frame.style.bottom = "0";
        frame.style.width = "1px";
        frame.style.height = "1px";
      } else {
        frame.style.display = "block";
        frame.style.pointerEvents = "auto";
        frame.style.opacity = "1";
        frame.style.left = "auto";
        frame.style.top = "auto";
        frame.style.right = "20px";
        frame.style.bottom = "20px";
        frame.style.width = "252px";
        frame.style.height = "96px";
      }
    }
  }

  function openWidget(evt) {
    if (evt && evt.preventDefault) evt.preventDefault();
    if (evt && evt.stopPropagation) evt.stopPropagation();
    if (displayMode !== "trigger") return;
    if (triggerAction === "link") {
      window.location.href = triggerLinkUrl || widgetUrl;
      return;
    }
    setPopupFrame(true);
    frame.style.opacity = "1";
    frame.style.pointerEvents = "auto";
    if (frameLoaded) {
      postBack(frame.contentWindow, widgetOrigin, { type: "f1g_widget_trigger_open" });
      window.setTimeout(function () {
        postBack(frame.contentWindow, widgetOrigin, { type: "f1g_widget_trigger_open" });
      }, 120);
    } else {
      pendingOpen = true;
    }
  }

  window.F1GENZCheckOrders = window.F1GENZCheckOrders || {};
  window.F1GENZCheckOrders[${JSON.stringify(publicShop)}] = {
    open: function () { openWidget(); },
    close: function () {
      if (displayMode === "trigger") {
        setPopupFrame(false);
        postBack(frame.contentWindow, widgetOrigin, { type: "f1g_widget_trigger_close" });
      }
    },
    url: widgetUrl
  };

  if (displayMode === "trigger") {
    setPopupFrame(false);
    document.addEventListener("click", function (evt) {
      var el = evt.target && evt.target.closest
        ? evt.target.closest("[data-f1g-checkorders-open]")
        : null;
      if (!el) return;
      var target = (el.getAttribute("data-f1g-checkorders-open") || "").trim();
      if (target && target !== ${JSON.stringify(publicShop)}) return;
      openWidget(evt);
    });
  }

  function normalizeItem(item) {
    var id = Number(item && item.id);
    var quantity = Number(item && item.quantity) || 1;
    if (!Number.isFinite(id) || id <= 0) return null;
    return { id: Math.floor(id), quantity: Math.max(1, Math.floor(quantity)) };
  }

  function addItem(item) {
    var body = new URLSearchParams();
    body.set("id", String(item.id));
    body.set("quantity", String(item.quantity));
    return fetch("/cart/add.js", {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "same-origin",
      body: body.toString()
    }).then(function (res) {
      if (!res.ok) throw new Error("add_to_cart_failed");
      return res.json();
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow || event.origin !== widgetOrigin) return;
    var data = event.data || {};

    if (data.type === "f1g_widget_popup_state") {
      setPopupFrame(data.open === true);
      return;
    }

    if (data.type !== "f1g_rebuy_add_to_cart") return;

    var requestId = data.requestId;
    var items = Array.isArray(data.items)
      ? data.items.map(normalizeItem).filter(Boolean)
      : [];

    postBack(event.source, event.origin, {
      type: "f1g_rebuy_add_to_cart_ack",
      requestId: requestId
    });

    if (!items.length) {
      postBack(event.source, event.origin, {
        type: "f1g_rebuy_add_to_cart_done",
        requestId: requestId,
        success: false,
        message: "empty_items"
      });
      return;
    }

    items.reduce(function (promise, item) {
      return promise.then(function () { return addItem(item); });
    }, Promise.resolve())
      .then(function () {
        postBack(event.source, event.origin, {
          type: "f1g_rebuy_add_to_cart_done",
          requestId: requestId,
          success: true
        });
        window.location.href = "/cart";
      })
      .catch(function () {
        postBack(event.source, event.origin, {
          type: "f1g_rebuy_add_to_cart_done",
          requestId: requestId,
          success: false,
          message: "add_to_cart_failed"
        });
      });
  });
})();`;

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(js);
  }

  private async sendWidget(
    store: StoreRecord,
    publicShop: string,
    res: Response,
  ) {
    // Read widget template
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

    // Replace Liquid template tags
    const apiUrl = widgetApiUrl();
    html = html.replace(
      /\{\{\s*settings\.f1g_order_api_url\s*\|\s*default:\s*'[^']*'\s*\}\}/g,
      apiUrl,
    );
    html = html.replace(
      /\{\{\s*settings\.f1g_order_shop\s*\|\s*default:\s*'[^']*'\s*\}\}/g,
      publicShop,
    );

    const frameHosts = [
      store.shop_domain,
      store.custom_domain,
      ...(store.shop_domains || []),
    ]
      .filter(Boolean)
      .map(
        (domain) =>
          `https://${String(domain)
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '')}`,
      );
    const uniqueFrameHosts = [...new Set(frameHosts)];

    // Fetch store settings and inject as config
    const settings = await this.storeService.getSettings(store.org_id);
    const configPayload = JSON.stringify({
      lookup_method: settings.lookup_method || 'phone_and_code',
      visible_fields: settings.visible_fields || [
        'order_number',
        'status',
        'created_at',
        'total_price',
        'fulfillment_status',
        'line_items',
        'phone',
        'email',
        'shipping_address',
      ],
      mask_phone: settings.mask_phone !== false,
      mask_email: settings.mask_email !== false,
      mask_address: settings.mask_address !== false,
      max_orders: settings.max_orders || 5,
      widget_enabled: settings.widget_enabled !== false,
      widget_display_mode: settings.widget_display_mode || 'inline',
      widget_trigger_action: settings.widget_trigger_action || 'modal',
      widget_trigger_link_url: settings.widget_trigger_link_url || '',
      theme_color: settings.theme_color || '#4361ee',
      widget_texts: settings.widget_texts || {},
      rebuy_enabled: settings.rebuy_enabled !== false,
      public_shop: publicShop,
      store_origin: uniqueFrameHosts[0] || `https://${store.shop_domain}`,
      store_origins: uniqueFrameHosts,
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '',
    });

    const fullHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tra cứu đơn hàng</title>
  <style>html,body{margin:0;padding:0;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}</style>
</head>
<body>
<script>window.__f1gConfig=${configPayload};</script>
${html}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const frameAncestors = ["'self'", ...uniqueFrameHosts];
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors ${frameAncestors.join(' ')}`,
    );
    res.send(fullHtml);
  }
}
