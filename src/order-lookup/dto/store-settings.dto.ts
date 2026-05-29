import {
  IsBoolean,
  IsOptional,
  IsString,
  IsInt,
  IsArray,
  Min,
  Max,
  IsIn,
  Matches,
  IsObject,
} from 'class-validator';

export const LOOKUP_METHODS = [
  'phone',
  'order_code',
  'phone_or_code',
  'phone_and_code',
] as const;
export type LookupMethod = (typeof LOOKUP_METHODS)[number];

export const VISIBLE_FIELD_OPTIONS = [
  'order_number',
  'status',
  'created_at',
  'total_price',
  'line_items',
  'fulfillment_status',
  'phone',
  'email',
  'shipping_address',
] as const;
export type VisibleField = (typeof VISIBLE_FIELD_OPTIONS)[number];

export const WIDGET_DISPLAY_MODES = ['inline', 'popup', 'trigger'] as const;
export type WidgetDisplayMode = (typeof WIDGET_DISPLAY_MODES)[number];

export const WIDGET_TRIGGER_ACTIONS = ['modal', 'link'] as const;
export type WidgetTriggerAction = (typeof WIDGET_TRIGGER_ACTIONS)[number];

export class UpdateStoreSettingsDto {
  @IsOptional()
  @IsBoolean()
  widget_enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(WIDGET_DISPLAY_MODES)
  widget_display_mode?: WidgetDisplayMode;

  @IsOptional()
  @IsString()
  @IsIn(LOOKUP_METHODS)
  lookup_method?: LookupMethod;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(VISIBLE_FIELD_OPTIONS, { each: true })
  visible_fields?: VisibleField[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  max_orders?: number;

  @IsOptional()
  @IsBoolean()
  mask_phone?: boolean;

  @IsOptional()
  @IsBoolean()
  mask_email?: boolean;

  @IsOptional()
  @IsBoolean()
  mask_address?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  theme_color?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  theme_text_color?: string;

  @IsOptional()
  @IsObject()
  widget_texts?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  rebuy_enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(WIDGET_TRIGGER_ACTIONS)
  widget_trigger_action?: WidgetTriggerAction;

  @IsOptional()
  @IsString()
  widget_trigger_link_url?: string;
}
