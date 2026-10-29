/**
 * Calls to the mini that read external food data. Nothing here writes user data; that goes
 * through the replica and sync. The result type makes every caller handle the mini being
 * out of reach.
 */
import type { ExternalRef, SearchHit } from '../domain/food.js';
import { LookupResponse, SearchResponse, formatRef } from '../protocol.js';

export type Online<T> =
  | { readonly ok: true; readonly value: T }
  /** offline: the mini did not answer. unavailable: it answered that its sources failed. */
  | { readonly ok: false; readonly reason: 'offline' | 'unavailable' | 'bad_response' };

async function getJson<T>(url: string, parse: (body: unknown) => T, signal?: AbortSignal): Promise<Online<T>> {
  let res: Response;
  try {
    res = await fetch(url, signal === undefined ? {} : { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, reason: 'offline' };
  }
  if (res.status >= 500) return { ok: false, reason: 'unavailable' };
  if (!res.ok) return { ok: false, reason: 'bad_response' };
  try {
    return { ok: true, value: parse(await res.json()) };
  } catch {
    return { ok: false, reason: 'bad_response' };
  }
}

export function lookupFood(ref: ExternalRef, signal?: AbortSignal): Promise<Online<LookupResponse>> {
  return getJson(`/api/foods/lookup/${formatRef(ref)}`, (body) => LookupResponse.parse(body), signal);
}

export function searchFoods(query: string, signal?: AbortSignal): Promise<Online<SearchHit[]>> {
  return getJson(`/api/foods/search?q=${encodeURIComponent(query)}`, (body) => SearchResponse.parse(body).hits, signal);
}
