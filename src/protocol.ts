/**
 * Wire schemas for POST /api/sync, shared by the server (which parses requests) and the
 * client (which parses responses). Documents stay `unknown` here and are parsed per kind
 * with parseDoc, so one bad document is rejected alone instead of failing its whole batch.
 */
import { z } from 'zod';
import { KindName } from './domain/kinds.js';

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

export const Healthz = z.object({ ok: z.literal(true), epoch: z.string(), rev: Rev });
export type Healthz = z.infer<typeof Healthz>;
