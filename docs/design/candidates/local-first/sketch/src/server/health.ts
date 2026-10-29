/**
 * Apple Health ingest from the iOS Shortcut. Parses the payload into HealthDay docs at the
 * boundary and merges them through the store's server-owned write path.
 */
import { todo } from '../todo.js';
import type { HealthDay } from '../domain/burn.js';
import type { Millis } from '../domain/ids.js';
import type { HealthIngestResponse } from '../protocol.js';
import type { DocStore } from './store.js';

/**
 * Pure. HealthIngestRequest to one HealthDay per listed date, every Reading stamped with
 * asOf = Date.parse(as_of). Units normalized here and only here: 'Cal'/'kcal' as kcal,
 * 'kJ' / 4.184, 'lb' to kg. An unknown unit string fails the whole payload with an error
 * naming the field, so a misbuilt Shortcut shows a readable notification.
 */
export function parseHealthIngest(raw: unknown): { ok: true; days: HealthDay[] } | { ok: false; error: string } {
  return todo(`parseHealthIngest(${typeof raw})`);
}

/**
 * Parse, then for each day store.writeServerDoc('health', healthDayId(date),
 * cur => mergeHealthDay(cur, day)). Logs the raw body and result to ingest_log.
 * Idempotent: the same payload sent any number of times, in any order relative to other
 * payloads, leaves the same documents and bumps no rev after the first time.
 */
export function ingestHealth(store: DocStore, rawBody: string, now: Millis): HealthIngestResponse {
  return todo(`ingestHealth(${typeof store}, ${rawBody.length}, ${now})`);
}
