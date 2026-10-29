/** What the Open Food Facts and USDA adapters share: calling a source and reading its numbers. */
import { Gtin } from '../domain/food.js';

/** The slice of `fetch` the adapters use, so tests can serve recorded responses. */
export type Fetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<Response>;

/**
 * The source could not answer: unreachable, timed out, a 5xx, or a body no parser can read.
 * It says nothing about the food, so it is never cached.
 */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
}

/** A reply that says something about the food: a success, or a 404 for a food the source lacks. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export const DEFAULT_TIMEOUT_MS = 8000;

export interface JsonRequest {
  readonly source: string;
  readonly fetch: Fetch;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** GETs a JSON answer. Anything that is neither a success nor a 404 throws UpstreamError. */
export async function getJson({ source, fetch, url, headers, timeoutMs }: JsonRequest): Promise<Answer> {
  let status: number;
  let text: string;
  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    text = await res.text();
  } catch (cause) {
    throw new UpstreamError(`${source}: request failed (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
  if (status !== 404 && (status < 200 || status > 299)) throw new UpstreamError(`${source}: HTTP ${status}`);
  try {
    return { status, body: parseJson(text) };
  } catch (cause) {
    if (status === 404) return { status, body: null };
    throw new UpstreamError(`${source}: HTTP ${status} with a body that is not JSON`, { cause });
  }
}

/** A number or numeric string that is finite and not negative. Anything else is unknown, never 0. */
export function amountOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A product code of a real GTIN length (8, 12, 13, or 14 with a leading 0) as a 13-digit Gtin. */
export function gtinOf(code: unknown): Gtin | null {
  if (typeof code !== 'string' || !/^(\d{8}|\d{12}|\d{13}|0\d{13})$/.test(code)) return null;
  const parsed = Gtin.safeParse(code.slice(-13).padStart(13, '0'));
  return parsed.success ? parsed.data : null;
}

export const trimSlash = (base: string): string => base.replace(/\/+$/, '');
