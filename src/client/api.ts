/**
 * Calls to the mini that read external food data or ask AI to read a meal. Nothing here
 * writes user data; that goes through the replica and sync. The result type makes every
 * caller handle the mini being out of reach.
 */
import type { ExternalRef, SearchHit } from '../domain/food.js';
import { AiAnswer, AiError, LookupResponse, SearchResponse, formatRef, type AiFailure, type AiParseRequest } from '../protocol.js';

/** offline: the mini did not answer. unavailable: it answered that its sources failed. */
export type OnlineFailure = 'offline' | 'unavailable' | 'bad_response';

/** `Why` adds the reasons a route names in its error body. */
export type Online<T, Why extends string = never> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OnlineFailure | Why };

interface Call<T, Why extends string> {
  readonly url: string;
  readonly init?: RequestInit;
  readonly parse: (body: unknown) => T;
  /** The reason in an error response's body, or null when it names none. */
  readonly reasonOf?: (body: unknown) => Why | null;
}

async function call<T, Why extends string = never>({ url, init = {}, parse, reasonOf }: Call<T, Why>): Promise<Online<T, Why>> {
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
  if (!res.ok) {
    const named = reasonOf?.(body) ?? null;
    if (named !== null) return { ok: false, reason: named };
    return { ok: false, reason: res.status >= 500 ? 'unavailable' : 'bad_response' };
  }
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

/** Asks the mini's AI to read a description or a photo. Online only: a request is never queued. */
export function parseWithAi(req: AiParseRequest, signal?: AbortSignal): Promise<Online<AiAnswer, AiFailure>> {
  return call({
    url: '/api/ai/parse',
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), ...withSignal(signal) },
    parse: (body) => AiAnswer.parse(body),
    reasonOf: (body) => {
      const named = AiError.safeParse(body);
      return named.success ? named.data.error : null;
    },
  });
}
