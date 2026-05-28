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
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 6) return '***';
    return cleaned.slice(0, 3) + '***' + cleaned.slice(-4);
  }

  maskEmail(email: string | undefined | null): string {
    if (!email) return '';
    const atIndex = email.indexOf('@');
    if (atIndex < 2) return '***@' + email.slice(atIndex + 1);
    return email[0] + '***' + email.slice(atIndex);
  }

  maskAddress(address: string | undefined | null): string {
    if (!address) return '';
    // Keep only the last part (city/province)
    const parts = address.split(',').map((s) => s.trim());
    if (parts.length <= 1) return '***';
    return '***' + parts.slice(-1).join(', ');
  }

  /**
   * Apply masking rules to an order result based on store settings.
   */
  applyMasking(
    order: Record<string, unknown>,
    settings: StoreSettings,
  ): Record<string, unknown> {
    const result = { ...order };

    if (settings.mask_phone && result.phone) {
      result.phone = this.maskPhone(result.phone as string);
    }

    if (settings.mask_email && result.email) {
      result.email = this.maskEmail(result.email as string);
    }

    if (settings.mask_address && result.shipping_address) {
      result.shipping_address = this.maskAddress(
        result.shipping_address as string,
      );
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

    // Always include order_number and status for display
    if (order.order_number) filtered.order_number = order.order_number;
    if (order.status_text) filtered.status_text = order.status_text;
    if (order.status_class) filtered.status_class = order.status_class;

    return filtered;
  }
}
