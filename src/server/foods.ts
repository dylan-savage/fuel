/**
 * The external food policy: which source answers a ref, how long its answer is trusted, and
 * how search results merge. The adapters (off.ts, usda.ts) read their source's JSON; this
 * module only hands bodies to their parsers.
 */
import type { ExternalRef, FoodCandidate, SearchHit } from '../domain/food.js';
import type { Millis } from '../domain/ids.js';
import type { LookupResponse } from '../protocol.js';
import { log } from './log.js';
import { parseOffProduct, type OffClient } from './off.js';
import type { LookupCache } from './store.js';
import { UpstreamError, type Answer } from './upstream.js';
import { parseUsdaFood, type UsdaClient } from './usda.js';

export interface FoodSources {
  /**
   * A barcode from Open Food Facts or a food from USDA. Answers are cached, found for 30 days
   * and not_found for 1 day. Throws UpstreamError when the source cannot answer.
   */
  lookup(ref: ExternalRef): Promise<LookupResponse>;
  /**
   * Up to `limit` hits from each source: USDA generic foods, then USDA branded foods, then
   * Open Food Facts, keeping the first hit per GTIN. One source failing leaves the other's
   * hits; every configured source failing throws UpstreamError.
   */
  search(q: string, limit: number): Promise<SearchHit[]>;
}

export interface FoodSourcesDeps {
  readonly off: OffClient;
  /** Null when USDA_API_KEY is unset: search is Open Food Facts only. */
  readonly usda: UsdaClient | null;
  readonly cache: LookupCache;
  readonly now: () => Millis;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_MS: Readonly<Record<LookupResponse['kind'], number>> = { found: 30 * DAY_MS, not_found: DAY_MS };

/** Where one ref's answer comes from, under which cache key, and how to read it. */
interface Lookup {
  readonly source: 'off' | 'usda';
  readonly key: string;
  readonly fetch: () => Promise<Answer>;
  readonly parse: (body: unknown, fetchedAt: Millis) => FoodCandidate | null;
}

const responseOf = (candidate: FoodCandidate | null): LookupResponse =>
  candidate === null ? { kind: 'not_found' } : { kind: 'found', candidate };

/** Keeps the first hit for each GTIN. Hits without one are never duplicates. */
function uniqueByGtin(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter(({ candidate: { barcodes } }) => {
    if (barcodes.some((gtin) => seen.has(gtin))) return false;
    for (const gtin of barcodes) seen.add(gtin);
    return true;
  });
}

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export function createFoodSources({ off, usda, cache, now }: FoodSourcesDeps): FoodSources {
  const lookupOf = (ref: ExternalRef): Lookup => {
    switch (ref.kind) {
      case 'gtin':
        return {
          source: 'off',
          key: ref.gtin,
          fetch: () => off.product(ref.gtin),
          parse: (body, fetchedAt) => parseOffProduct(body, ref.gtin, fetchedAt),
        };
      case 'usda':
        return {
          source: 'usda',
          key: String(ref.fdcId),
          fetch: async () => {
            if (usda === null) throw new UpstreamError('usda: USDA_API_KEY is not set');
            return usda.food(ref.fdcId);
          },
          parse: (body) => parseUsdaFood(body),
        };
    }
  };

  return {
    lookup: async (ref) => {
      const { source, key, fetch, parse } = lookupOf(ref);
      const cached = cache.get(source, key);
      if (cached !== null) {
        const response = responseOf(parse(cached.body, cached.fetchedAt));
        if (now() - cached.fetchedAt < FRESH_MS[response.kind]) return response;
      }
      const answer = await fetch();
      const fetchedAt = now();
      const response = responseOf(parse(answer.body, fetchedAt));
      cache.put(source, key, { ...answer, fetchedAt });
      return response;
    },

    search: async (q, limit) => {
      const [fromUsda, fromOff] = await Promise.allSettled([usda?.search(q, limit) ?? null, off.search(q, limit)]);
      const failures = [fromUsda, fromOff].flatMap((r) => (r.status === 'rejected' ? [messageOf(r.reason)] : []));
      const usdaHits = fromUsda.status === 'fulfilled' ? fromUsda.value : null;
      const offHits = fromOff.status === 'fulfilled' ? fromOff.value : null;
      if (usdaHits === null && offHits === null) throw new UpstreamError(`every food source failed: ${failures.join('; ')}`);
      if (failures.length > 0) log('food_search_degraded', { failures });
      return uniqueByGtin([...(usdaHits?.generic ?? []), ...(usdaHits?.branded ?? []), ...(offHits ?? [])]);
    },
  };
}
