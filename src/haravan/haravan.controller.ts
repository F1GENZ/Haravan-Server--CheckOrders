import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Response,
  Req,
} from '@nestjs/common';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { HaravanService } from './haravan.service';

@Controller('/oauth/install')
export class HaravanController {
  constructor(private readonly haravanService: HaravanService) {}

  @Get('/login')
  async login(
    @Query('orgid') orgid?: string | string[],
    @Query('shop') shop?: string | string[],
  ) {
    return await this.haravanService.loginApp(orgid, shop);
  }

  @Get('/login/verify-hmac')
  async verifyHmac(@Req() req: ExpressRequest) {
    // Pass the raw query string to preserve original param order
    // (Haravan computes HMAC using original order, NOT sorted)
    const rawQuery = req.url.split('?')[1] || '';
    return await this.haravanService.verifyHmac(rawQuery);
  }

  @Post('/login/callback')
  async loginCallbackPost(
    @Body('code') code: string,
    @Body('state') state: string | undefined,
    @Req() req: ExpressRequest,
    @Response() res: ExpressResponse,
  ) {
    return await this.haravanService.processLoginCallback(
      code,
      state,
      req,
      res,
    );
  }

  @Get('/login/callback')
  async loginCallbackGet(
    @Query('code') code: string,
    @Query('state') state: string | undefined,
    @Req() req: ExpressRequest,
    @Response() res: ExpressResponse,
  ) {
    return await this.haravanService.processLoginCallback(
      code,
      state,
      req,
      res,
    );
  }

  @Get('/grandservice')
  async install(
    @Query('code') code: string,
    @Query('state') state: string | undefined,
    @Response() res: ExpressResponse,
  ) {
    await this.haravanService.installApp(code, state, res);
  }

  @Get('/webhooks')
  webhookChallenge(@Query() query: Record<string, unknown>) {
    return this.haravanService.verifyWebhookChallenge(query);
  }

  @Post('/webhooks')
  async webhook(@Req() req: ExpressRequest) {
    return await this.haravanService.handleWebhook(req);
  }
}
