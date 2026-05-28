import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

type ShopAuthRequest = {
  orgid?: string;
};

export const ShopOrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<ShopAuthRequest>();
    return request.orgid;
  },
);

export const ALLOW_EXPIRED_HARAVAN_TOKEN = 'allow_expired_haravan_token';
export const AllowExpiredHaravanToken = () =>
  SetMetadata(ALLOW_EXPIRED_HARAVAN_TOKEN, true);
