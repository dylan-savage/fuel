/** Open Food Facts adapter. Raw JSON stays in this file; callers get FoodCandidate. */
import { todo } from '../todo.js';
import type { FoodCandidate } from '../domain/food.js';
import type { Gtin, Millis } from '../domain/ids.js';

export interface OffClient {
  /**
   * GET https://world.openfoodfacts.org/api/v2/product/{gtin}.json?fields=code,product_name,
   * generic_name,brands,nutriments,serving_size,serving_quantity,nutrition_data_per,quantity
   * with a descriptive User-Agent. Returns the raw body, or null on status 0 / 404.
   * Throws on network failure so the caller does not cache it as not_found.
   */
  product(gtin: Gtin): Promise<unknown | null>;
}

export function createOffClient(cfg: { userAgent: string; fetch?: typeof fetch }): OffClient {
  return todo(`createOffClient(${cfg.userAgent})`);
}

/**
 * Pure. OFF product JSON to a candidate, or null when no energy can be derived.
 * Rules, each pinned by a recorded fixture:
 * - name: product_name, else generic_name. brand: first of brands.
 * - unit: ml when nutrition_data_per is '100ml' or quantity is in ml/l, else g. per = 100.
 * - kcal: energy-kcal_100g, else energy-kj_100g / 4.184 (energy_100g is kJ), else Atwater.
 * - sodium_100g is grams, stored as mg. salt is ignored when sodium is present.
 * - only _serving values: divide by serving_quantity to get per 100; without
 *   serving_quantity the candidate is unit 'portion', per 1.
 * - servings: one from serving_quantity + serving_size label when present.
 * - source: { kind: 'off', gtin, fetchedAt }, barcodes: [gtin].
 */
export function parseOffProduct(raw: unknown, gtin: Gtin, fetchedAt: Millis): FoodCandidate | null {
  return todo(`parseOffProduct(${typeof raw}, ${gtin}, ${fetchedAt})`);
}
