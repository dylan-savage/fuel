/**
 * The online-only calls: external food search and lookup, and AI quick log. Everything else
 * the phone does is local. Responses are parsed with protocol schemas and unwrapped into
 * domain types, so screens never see an envelope or raw JSON.
 */
import { todo } from '../todo.js';
import type { AiResult, ExternalRef, FoodCandidate, SearchHit } from '../domain/food.js';
import type { AiParseRequest } from '../protocol.js';

/**
 * Every online call can fail for a reason the screen must handle, and the type forces it.
 * 'offline': no route to the mini (fetch threw or timed out after 8 s).
 * 'unavailable': the mini answered 5xx, or 503 ai_unconfigured.
 * 'bad_response': the body failed its schema (client and server out of step).
 */
export type Online<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'offline' | 'unavailable' | 'bad_response'; readonly detail?: string };

export interface Api {
  searchFoods(q: string, signal?: AbortSignal): Promise<Online<SearchHit[]>>;
  /** value null = the source has no such food (barcode not in OFF). */
  lookup(ref: ExternalRef): Promise<Online<FoodCandidate | null>>;
  aiParse(req: AiParseRequest): Promise<Online<AiResult>>;
}

export function createApi(opts?: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }): Api {
  return todo(`createApi(${typeof opts})`);
}

/** Canvas downscale to at most 1280 px on the long edge, JPEG quality 0.8, for label and plate photos. */
export function preparePhoto(file: Blob): Promise<{ mediaType: 'image/jpeg'; base64: string }> {
  return todo(`preparePhoto(${file.size})`);
}
