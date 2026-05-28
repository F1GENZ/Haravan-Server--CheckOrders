import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

const normalizePhone = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  let phone = value.replace(/[\s\-().]/g, '');
  if (phone.startsWith('+84')) phone = `0${phone.slice(3)}`;
  if (phone.startsWith('84') && phone.length > 10) phone = `0${phone.slice(2)}`;
  return phone;
};

const normalizeShop = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
};

export class LookupRequestDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeShop(value))
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9][a-z0-9.-]{0,254}$/, {
    message: 'Shop không hợp lệ',
  })
  shop?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(/^0\d{9,10}$/, { message: 'Số điện thoại không hợp lệ' })
  phone?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9#-]{1,30}$/, { message: 'Mã đơn hàng không hợp lệ' })
  order_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captcha_token?: string;
}
