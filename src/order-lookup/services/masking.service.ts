import { Injectable } from '@nestjs/common';
import type { StoreSettings } from './store.service';

/**
 * MaskingService — Data privacy agent
 *
 * Masks sensitive fields before returning to the client,
 * based on the store's privacy settings.
 */
@Injectable()
export class MaskingService {
  maskPhone(phone: string | undefined | null): string {
    if (!phone) return '';
    const raw = String(phone).trim();
    if (raw.includes('***')) return raw;
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length < 6) return '***';
    return cleaned.slice(0, 3) + '***' + cleaned.slice(-4);
  }

  maskEmail(email: string | undefined | null): string {
    if (!email) return '';
    const raw = String(email).trim();
    if (raw.includes('***')) return raw;
    const atIndex = raw.indexOf('@');
    if (atIndex < 0) return '***';
    if (atIndex < 2) return '***@' + raw.slice(atIndex + 1);
    return raw[0] + '***' + raw.slice(atIndex);
  }

  maskAddress(address: string | undefined | null): string {
    if (!address) return '';
    const raw = String(address).trim();
    if (raw.includes('***')) return raw;
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    while (
      parts.length > 1 &&
      /^(viet\s*nam|việt\s*nam|vn)$/i.test(parts[parts.length - 1])
    ) {
      parts.pop();
    }
    if (parts.length <= 1) return '***';
    return '***' + parts[parts.length - 1];
  }

  maskName(name: string | undefined | null): string {
    if (!name) return '';
    const raw = String(name).trim();
    if (!raw || raw.includes('***')) return raw;
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length >= 3) {
      return `${words[0]} *** ${words[words.length - 1]}`;
    }
    if (words.length === 2) {
      return `${words[0]} ${words[1][0] || ''}***`;
    }
    return `${raw[0] || ''}***`;
  }

  /**
   * Apply masking rules to an order result based on store settings.
   */
  applyMasking(
    order: Record<string, unknown>,
    settings: StoreSettings,
    context?: { lookedUpWithoutPhone?: boolean },
  ): Record<string, unknown> {
    const result = { ...order };
    const forceMaskForCodeOnly = Boolean(context?.lookedUpWithoutPhone);

    if ((settings.mask_phone || forceMaskForCodeOnly) && result.phone) {
      result.phone = this.maskPhone(result.phone as string);
    }

    if ((settings.mask_email || forceMaskForCodeOnly) && result.email) {
      result.email = this.maskEmail(result.email as string);
    }

    if (
      (settings.mask_address || forceMaskForCodeOnly) &&
      result.shipping_address
    ) {
      result.shipping_address = this.maskAddress(
        result.shipping_address as string,
      );
    }

    if (forceMaskForCodeOnly && result.customer_name) {
      result.customer_name = this.maskName(result.customer_name as string);
    }

    return result;
  }

  /**
   * Filter order fields to only include those allowed by store settings.
   */
  filterFields(
    order: Record<string, unknown>,
    visibleFields: string[],
  ): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};

    for (const field of visibleFields) {
      if (field in order) {
        filtered[field] = order[field];
      }
    }

    // Always include helper fields required by storefront rendering
    if (visibleFields.includes('customer_name') && order.customer_name) {
      filtered.customer_name = order.customer_name;
    }
    if (order.order_number) filtered.order_number = order.order_number;
    if (order.status_text) filtered.status_text = order.status_text;
    if (order.status_class) filtered.status_class = order.status_class;
    if (order.confirmed) filtered.confirmed = true;
    if (visibleFields.includes('status') && order.financial_status) {
      filtered.financial_status = order.financial_status;
    }
    if (visibleFields.includes('total_price')) {
      if (order.subtotal_price) filtered.subtotal_price = order.subtotal_price;
      if (order.total_discounts)
        filtered.total_discounts = order.total_discounts;
      if (order.total_shipping) filtered.total_shipping = order.total_shipping;
      if (order.gateway) filtered.gateway = order.gateway;
    }
    if (visibleFields.includes('fulfillment_status')) {
      if (order.fulfillment_status_raw)
        filtered.fulfillment_status_raw = order.fulfillment_status_raw;
    }
    if (
      (visibleFields.includes('status') ||
        visibleFields.includes('fulfillment_status')) &&
      order.cancelled_at
    ) {
      filtered.cancelled_at = order.cancelled_at;
    }
    if (visibleFields.includes('tracking_info') && order.tracking) {
      filtered.tracking = order.tracking;
    }

    return filtered;
  }
}
