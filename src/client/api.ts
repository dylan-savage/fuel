/**
 * Calls to the mini. Nothing here writes user data; that goes through the replica and sync.
 * The result type makes every caller handle the mini being out of reach.
 */
import type { ExternalRef, SearchHit } from '../domain/food.js';
import { LookupResponse, SearchResponse, formatRef } from '../protocol.js';

/** offline: the mini did not answer. unavailable: it answered that its sources failed. */
export type OnlineFailure = 'offline' | 'unavailable' | 'bad_response';

export type Online<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: OnlineFailure };

interface Call<T> {
  readonly url: string;
  readonly init?: RequestInit;
  readonly parse: (body: unknown) => T;
}

async function call<T>({ url, init = {}, parse }: Call<T>): Promise<Online<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    return { ok: false, reason: 'offline' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: res.status >= 500 ? 'unavailable' : 'bad_response' };
  }
  if (!res.ok) return { ok: false, reason: res.status >= 500 ? 'unavailable' : 'bad_response' };
  try {
    return { ok: true, value: parse(body) };
  } catch {
    return { ok: false, reason: 'bad_response' };
  }
}

const withSignal = (signal: AbortSignal | undefined): RequestInit => (signal === undefined ? {} : { signal });

export function lookupFood(ref: ExternalRef, signal?: AbortSignal): Promise<Online<LookupResponse>> {
  return call({ url: `/api/foods/lookup/${formatRef(ref)}`, init: withSignal(signal), parse: (body) => LookupResponse.parse(body) });
}

export function searchFoods(query: string, signal?: AbortSignal): Promise<Online<SearchHit[]>> {
  return call({ url: `/api/foods/search?q=${encodeURIComponent(query)}`, init: withSignal(signal), parse: (body) => SearchResponse.parse(body).hits });
}
