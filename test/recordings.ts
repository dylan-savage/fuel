import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Answer, Fetch } from '../src/server/upstream.js';

/** One real response written by scripts/record-fixtures.mjs. */
const Recording = z.object({ request: z.url(), status: z.number().int(), recordedAt: z.iso.datetime(), body: z.unknown() });
export type Recording = z.infer<typeof Recording>;

export function recording(source: 'off' | 'usda', name: string): Recording {
  const text = readFileSync(new URL(`fixtures/${source}/${name}.json`, import.meta.url), 'utf8');
  return Recording.parse(JSON.parse(text));
}

export const answerOf = ({ status, body }: Recording): Answer => ({ status, body });

export interface Sent {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fetch that answers each request with the recording of that exact URL, and keeps what was sent. */
export function replay(...recordings: Recording[]): { readonly fetch: Fetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: Fetch = (url, { headers }) => {
    sent.push({ url, headers });
    const match = recordings.find((r) => r.request === url);
    if (match === undefined) return Promise.reject(new Error(`no recording of ${url}; rerun scripts/record-fixtures.mjs`));
    return Promise.resolve(new Response(JSON.stringify(match.body), { status: match.status }));
  };
  return { fetch, sent };
}
