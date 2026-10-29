/**
 * Every HTTP request and response body, as zod schemas shared by the server (which parses
 * requests) and the client (which parses responses). Screens never import this file:
 * client/sync.ts and client/api.ts parse wire data into domain types behind their interfaces.
 */
import { z } from 'zod';
import { todo } from './todo.js';
import { AiResult, FoodCandidate, SearchHit, type ExternalRef } from './domain/food.js';
import { LocalDate } from './domain/ids.js';
import { KindName } from './domain/kinds.js';

// ---------- POST /api/sync ----------

/** Global, server-assigned, strictly increasing per write. The only ordering sync trusts. */
export const Rev = z.number().int().nonnegative().brand<'Rev'>();
export type Rev = z.infer<typeof Rev>;

/** One per replica (a browser profile's IndexedDB), minted on first launch. */
export const ClientId = z.uuid().brand<'ClientId'>();
export type ClientId = z.infer<typeof ClientId>;

/** Per-client, gapless, starting at 1, assigned in the same IndexedDB transaction as the write. */
export const MutationId = z.number().int().positive().brand<'MutationId'>();
export type MutationId = z.infer<typeof MutationId>;

/**
 * A whole-document write: doc is the full new document, or null for delete.
 * The server parses doc with parseDoc(kind), requires doc.id === docId, and rejects
 * kinds whose writer is 'server'.
 */
export const WireMutation = z.object({
  id: MutationId,
  kind: KindName,
  docId: z.string().min(1),
  doc: z.unknown().nullable(),
});
export type WireMutation = z.infer<typeof WireMutation>;

/** A document as of rev. doc null = tombstone. Tombstones are kept forever (one user; they are tiny). */
export const DocRecord = z.object({
  kind: KindName,
  id: z.string().min(1),
  rev: Rev,
  doc: z.unknown().nullable(),
});
export type DocRecord = z.infer<typeof DocRecord>;

/**
 * A mutation the server refused (schema failure, server-owned kind, id mismatch). It still
 * counts as processed so the outbox never wedges. current is the server's copy of that doc
 * (null if it never existed) so the client can undo its optimistic write.
 */
export const Rejection = z.object({ mutationId: MutationId, reason: z.string(), current: DocRecord.nullable() });
export type Rejection = z.infer<typeof Rejection>;

export const SyncRequest = z.object({
  clientId: ClientId,
  /** The server epoch this replica last completed a pull against. Null on first launch. */
  epoch: z.string().nullable(),
  cursor: Rev,
  /** Oldest first. The server applies only ids above its recorded lastMutationId for this client. */
  mutations: z.array(WireMutation).max(500),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncResponse = z.object({
  /** Regenerated when the database is restored from backup. A mismatch makes the server ignore cursor and send from 0. */
  epoch: z.string(),
  /** Highest mutation id this server has processed for the client (0 if none). Outbox rows at or below it are done. */
  lastMutationId: z.number().int().nonnegative(),
  rejected: z.array(Rejection),
  /** Docs with rev > cursor, rev ascending, at most 1000. Includes the client's own writes echoed back. */
  changes: z.array(DocRecord),
  cursor: Rev,
  more: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

// ---------- GET /api/foods/search?q= and GET /api/foods/lookup/:ref ----------

/** Parses the `:ref` path segment, `gtin:0049000000443` or `usda:171077`. Null means 400. */
export function parseRefParam(raw: string): ExternalRef | null {
  return todo(`parseRefParam(${raw})`);
}

/** The inverse of parseRefParam, used by client/api.ts to build the URL. */
export function formatRefParam(ref: ExternalRef): string {
  return todo(`formatRefParam(${ref.kind})`);
}

export const FoodSearchResponse = z.object({ hits: z.array(SearchHit) });
export type FoodSearchResponse = z.infer<typeof FoodSearchResponse>;

export const LookupResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), candidate: FoodCandidate }),
  z.object({ kind: z.literal('not_found') }),
]);
export type LookupResponse = z.infer<typeof LookupResponse>;

// ---------- POST /api/ai/parse ----------

export const AiParseRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(2).max(500) }),
  z.object({
    kind: z.literal('photo'),
    subject: z.enum(['label', 'plate']),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    /** Downscaled on the phone to at most 1280 px on the long edge before upload. */
    base64: z.string().max(4_000_000),
  }),
]);
export type AiParseRequest = z.infer<typeof AiParseRequest>;

/** The body is the domain AiResult itself; there is no envelope to unwrap. */
export const AiParseResponse = AiResult;
export type AiParseResponse = AiResult;

// ---------- POST /api/health/ingest (the iOS Shortcut) ----------

/** Shortcuts dictionaries sometimes send numbers as text, so values are coerced here and nowhere else. */
const Energy = z.object({ value: z.coerce.number().nonnegative(), unit: z.string() });
const Mass = z.object({ value: z.coerce.number().positive(), unit: z.string() });

export const HealthIngestRequest = z.object({
  v: z.literal(1),
  /** When the Shortcut read Health, with offset. Becomes Reading.asOf for every value in the payload. */
  as_of: z.iso.datetime({ offset: true }),
  days: z
    .array(
      z.object({
        date: LocalDate,
        /** Cumulative active energy for that day so far. Unit 'kcal', 'Cal' or 'kJ'. */
        active_energy: Energy.optional(),
        steps: z.coerce.number().nonnegative().optional(),
        /** Latest body mass sample that day. Unit 'lb' or 'kg'. */
        weight: Mass.optional(),
      }),
    )
    .min(1)
    .max(7),
});
export type HealthIngestRequest = z.infer<typeof HealthIngestRequest>;

/** The Shortcut tests `ok` is true. It never infers success from the absence of an error. */
export const HealthIngestResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), stored: z.number().int(), unchanged: z.number().int() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type HealthIngestResponse = z.infer<typeof HealthIngestResponse>;

// ---------- shared ----------

export const ApiError = z.object({ error: z.string() });
export const Healthz = z.object({ ok: z.literal(true), epoch: z.string(), rev: Rev, dbBytes: z.number() });
