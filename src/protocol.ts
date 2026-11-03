/**
 * Wire schemas for every HTTP body, shared by the server (which parses requests) and the
 * client (which parses responses). Sync documents stay `unknown` here and are parsed per
 * kind with parseDoc, so one bad document is rejected alone instead of failing its batch.
 */
import { z } from 'zod';
import { FdcId, FoodCandidate, Gtin, SearchHit, type ExternalRef } from './domain/food.js';
import { KindName } from './domain/kinds.js';
import { Draft, FoodHint, MAX_HINTS } from './domain/quicklog.js';

/** Server-assigned, strictly increasing per applied mutation. The only order sync trusts. */
export const Rev = z.number().int().nonnegative().brand<'Rev'>();
export type Rev = z.infer<typeof Rev>;

/** One per replica (a browser profile's IndexedDB), minted on first launch. */
export const ClientId = z.uuid().brand<'ClientId'>();
export type ClientId = z.infer<typeof ClientId>;

/** Per client, increasing, assigned in the same IndexedDB transaction as the write. */
export const MutationId = z.number().int().positive().brand<'MutationId'>();
export type MutationId = z.infer<typeof MutationId>;

const DocId = z.string().min(1).max(200);

/**
 * A whole-document put or a delete, nothing else. docId travels with a put so a document
 * that fails validation can still be named in the rejection.
 */
export const WireMutation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('put'), id: MutationId, kind: KindName, docId: DocId, doc: z.unknown() }),
  z.object({ op: z.literal('delete'), id: MutationId, kind: KindName, docId: DocId }),
]);
export type WireMutation = z.infer<typeof WireMutation>;

/** A document as of rev. doc null is a tombstone. */
export const DocRecord = z.object({
  kind: KindName,
  id: DocId,
  rev: Rev,
  doc: z.unknown().nullable(),
});
export type DocRecord = z.infer<typeof DocRecord>;

/**
 * A mutation the server refused. It still counts as processed so the outbox never wedges.
 * `current` is the server's copy of that document (null if it has none) so the phone can
 * undo its optimistic write.
 */
export const Rejection = z.object({
  mutationId: MutationId,
  kind: KindName,
  docId: DocId,
  reason: z.string(),
  current: DocRecord.nullable(),
});
export type Rejection = z.infer<typeof Rejection>;

export const MAX_PUSH = 500;

export const SyncRequest = z.object({
  clientId: ClientId,
  /** The server epoch this replica last pulled against. Null before the first sync. */
  epoch: z.string().nullable(),
  cursor: Rev,
  mutations: z
    .array(WireMutation)
    .max(MAX_PUSH)
    .refine((ms) => ms.every((m, i) => i === 0 || m.id > (ms[i - 1]?.id ?? 0)), 'mutation ids must ascend'),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncResponse = z.object({
  /** Regenerated when the database is restored. A mismatch makes the server pull from 0. */
  epoch: z.string(),
  /** Highest mutation id processed for this client (0 if none). Outbox rows at or below it are done. */
  lastMutationId: z.number().int().nonnegative(),
  rejected: z.array(Rejection),
  /** Documents with rev above the cursor, rev ascending. Includes the client's own writes. */
  changes: z.array(DocRecord),
  cursor: Rev,
  /** More changes wait above `cursor`. */
  more: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

/**
 * A SyncResponse as a shell receives it. The shell may be older than the server, so each
 * record stays unknown here and SyncPort.apply parses it alone: one record this shell
 * cannot read is skipped instead of failing its batch.
 */
export const SyncReply = SyncResponse.extend({ changes: z.array(z.unknown()) });
export type SyncReply = z.infer<typeof SyncReply>;

export const Healthz = z.object({ ok: z.literal(true), epoch: z.string(), rev: Rev });
export type Healthz = z.infer<typeof Healthz>;

/** The `:ref` path segment of GET /api/foods/lookup: `gtin:<13 digits>` or `usda:<fdcId>`. */
export function formatRef(ref: ExternalRef): string {
  switch (ref.kind) {
    case 'gtin':
      return `gtin:${ref.gtin}`;
    case 'usda':
      return `usda:${ref.fdcId}`;
  }
}

export function parseRef(segment: string): ExternalRef | null {
  const [scheme, value = ''] = segment.split(':', 2);
  if (scheme === 'gtin') {
    const gtin = Gtin.safeParse(value);
    return gtin.success ? { kind: 'gtin', gtin: gtin.data } : null;
  }
  if (scheme === 'usda' && /^\d+$/.test(value)) {
    const fdcId = FdcId.safeParse(Number(value));
    return fdcId.success ? { kind: 'usda', fdcId: fdcId.data } : null;
  }
  return null;
}

/** GET /api/foods/lookup/:ref. The source answered; it may not know the food. */
export const LookupResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), candidate: FoodCandidate }),
  z.object({ kind: z.literal('not_found') }),
]);
export type LookupResponse = z.infer<typeof LookupResponse>;

/** GET /api/foods/search?q=. Generic USDA foods first, then branded products. */
export const SearchResponse = z.object({ hits: z.array(SearchHit) });
export type SearchResponse = z.infer<typeof SearchResponse>;

export const MAX_PHOTO_BASE64 = 4_000_000;
export const PhotoType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export type PhotoType = z.infer<typeof PhotoType>;

const Hints = z.array(FoodHint).max(MAX_HINTS);

/**
 * POST /api/ai/parse. `foods` are Dylan's foods for the model to match drafts against; a
 * label becomes a new food, so it sends none.
 */
export const AiParseRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(2).max(1000), foods: Hints }),
  z.object({
    kind: z.literal('photo'),
    subject: z.enum(['label', 'plate']),
    mediaType: PhotoType,
    base64: z.string().min(1).max(MAX_PHOTO_BASE64),
    foods: Hints,
  }),
]);
export type AiParseRequest = z.infer<typeof AiParseRequest>;

/** What the model made of it: drafts to review for text and plates, a food to confirm for a label. Nothing is written. */
export const AiAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drafts'), drafts: z.array(Draft).min(1) }),
  z.object({ kind: z.literal('label'), candidate: FoodCandidate }),
]);
export type AiAnswer = z.infer<typeof AiAnswer>;

/** Why /api/ai/parse has no answer, in the body of its error status. */
export const AiFailure = z.enum([
  /** No ANTHROPIC_API_KEY on the mini. */
  'ai_unconfigured',
  /** The API could not be reached, or answered with an error. */
  'ai_unavailable',
  'ai_timeout',
  'ai_refused',
  /** The model's reply did not fit the schema, or was cut off. */
  'ai_unreadable',
  /** No food in the text or photo, or no nutrition label in the photo. */
  'ai_nothing_found',
]);
export type AiFailure = z.infer<typeof AiFailure>;

export const AiError = z.object({ error: AiFailure });
export type AiError = z.infer<typeof AiError>;
