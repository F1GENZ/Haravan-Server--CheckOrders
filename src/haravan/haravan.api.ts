import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { BadRequestException } from '@nestjs/common/exceptions';

// ─── Types ───

type RecordData = Record<string, unknown>;

type ShopResponse = RecordData & { shop?: RecordData };

/**
 * HaravanAPIService — Haravan Omni API client
 *
 * Stripped to only shop-related calls.
 */
@Injectable()
export class HaravanAPIService {
  // ─── Shop API ───

  async getShop(token: string): Promise<RecordData> {
    const response = await axios.get<ShopResponse>(
      'https://apis.haravan.com/com/shop.json',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data || !response.data.shop) {
      throw new BadRequestException('Failed to fetch shop info');
    }
    return response.data.shop;
  }
}
