/**
 * External food lookup policy: which source answers which question, caching, and merging.
 * The adapters (off.ts, usda.ts) know their source's JSON; this module knows neither.
 */
import { todo } from '../todo.js';
import type { ExternalRef, FoodCandidate, SearchHit } from '../domain/food.js';
import type { Millis } from '../domain/ids.js';
import type { OffClient } from './off.js';
import type { UsdaClient } from './usda.js';
import type { LookupCache } from './store.js';

export interface FoodSources {
  /**
   * Generic foods from USDA (Foundation and SR Legacy), then branded results. Deduped by
   * normalized name and brand. One source failing returns the other's hits; both failing
   * throws, and the route answers 502. OFF text search joins after its endpoint is verified.
   */
  search(q: string, limit: number): Promise<SearchHit[]>;

  /**
   * gtin: OFF product, cached 30 days when found and 1 day when not found.
   * usda: FDC food detail with portions as servings, cached 30 days.
   * Null means the source has no such food.
   */
  lookup(ref: ExternalRef): Promise<FoodCandidate | null>;
}

export function createFoodSources(deps: {
  off: OffClient;
  usda: UsdaClient;
  cache: LookupCache;
  now: () => Millis;
}): FoodSources {
  return todo(`createFoodSources(${typeof deps.off})`);
}
