export interface OrderResult {
  order_number: string;
  status_text: string;
  status_class: 'success' | 'pending' | 'shipping' | 'cancelled' | 'error';
  created_at?: string;
  total_price?: string;
  fulfillment_status?: string;
  line_items?: Array<{
    title: string;
    quantity: number;
    price?: string;
    variant_id?: number;
    product_id?: number;
    product_url?: string;
    image?: string;
  }>;
  phone?: string;
  email?: string;
  shipping_address?: string;
}

export interface LookupResponseDto {
  success: boolean;
  orders?: OrderResult[];
  error?: string;
  message?: string;
  require_captcha?: boolean;
}
