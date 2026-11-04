/**
 * Wire schemas for every HTTP body, shared by the server (which parses requests) and the
 * client (which parses responses). Sync documents stay `unknown` here and are parsed per
 * kind with parseDoc, so one bad document is rejected alone instead of failing its batch.
 */
import { z } from 'zod';
import { FdcId, FoodCandidate, Gtin, SearchHit, type ExternalRef } from './domain/food.js';
import { LocalDate, Millis, ProgramId } from './domain/ids.js';
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
  /** The shell's build id. Shells that cannot skip what they cannot read send none, so its presence alone says this one can. */
  build: z.string().min(1).max(100).optional(),
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

/** The latest build a phone reported on sync, and when. Null until one does. */
export const PhoneBuild = z.object({ build: z.string(), at: Millis });
export type PhoneBuild = z.infer<typeof PhoneBuild>;

export const Healthz = z.object({ ok: z.literal(true), epoch: z.string(), rev: Rev, phoneBuild: PhoneBuild.nullable() });
export type Healthz = z.infer<typeof Healthz>;

const PublishProblem = z.object({ code: z.string(), path: z.string(), message: z.string() });

const PublishDiffItem = z.object({
  kind: z.string(),
  target: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  needsReason: z.boolean(),
  why: z.string().nullable(),
});

/**
 * POST /api/train/publish. Every outcome names itself, unlike a sync push, where a refused
 * document is a rejection inside a 200. The body is a draft plus basedOnRev, and stays unknown
 * here because parseProgramDraft reports every problem in it at once.
 */
export const PublishAnswer = z.discriminatedUnion('status', [
  /** 200. `rev` is what to base the next publish on. */
  z.object({ status: z.literal('published'), id: ProgramId, rev: Rev }),
  /** 200. The version already holds this content, so a retry after a lost response lands here. */
  z.object({ status: z.literal('unchanged'), id: ProgramId, rev: Rev }),
  /** 200. Nothing written. `phoneBehind` says the same draft would answer phone_behind today. */
  z.object({ status: z.literal('dry-run'), id: ProgramId, diff: z.array(PublishDiffItem), phoneBehind: z.boolean() }),
  /** 422. Nothing written. */
  z.object({ status: z.literal('invalid'), problems: z.array(PublishProblem) }),
  /** 409. Nothing written. The version has taken effect. */
  z.object({ status: z.literal('frozen'), id: ProgramId, earliestEffectiveFrom: LocalDate, problems: z.array(PublishProblem) }),
  /** 409. Nothing written. The plan moved after this draft was read. */
  z.object({ status: z.literal('stale'), basedOnRev: Rev, currentRev: Rev }),
  /** 409. Nothing written. No shell that can skip an unknown kind has reported in. */
  z.object({ status: z.literal('phone_behind') }),
]);
export type PublishAnswer = z.infer<typeof PublishAnswer>;

const ImportCounts = z.object({ session: z.number().int(), performance: z.number().int(), weighIn: z.number().int() });
const ImportedDoc = z.object({ kind: z.enum(['session', 'performance', 'weighIn']), id: z.string() });
const DayShift = z.object({ date: LocalDate, before: z.number(), after: z.number(), change: z.number() });
const TargetShift = z.object({ days: z.array(DayShift), largest: DayShift.nullable() });

const ImportedFields = {
  /** Sha-256 of the documents, the one scripts/reconcile-history.mjs prints for the same file. */
  digest: z.string(),
  /** What the file holds, whatever was stored already. */
  inFile: z.object({ sessions: z.number().int(), performances: z.number().int(), sets: z.number().int(), lifts: z.number().int() }),
  written: ImportCounts,
  unchanged: ImportCounts,
  /** A phone last wrote these and they differ, so they were left as Dylan left them. */
  conflicts: z.array(ImportedDoc),
  /** Written by an earlier import and gone from this file, so they still count until someone removes them. */
  orphans: z.array(ImportedDoc),
  weighIns: z.object({
    /** Null when fuel has none, and `meaning` says what follows from that. */
    firstInFuel: LocalDate.nullable(),
    /** Dates written unless a phone holds that day. */
    newer: z.array(LocalDate),
    /** Dates written only under ?weighIns=1. */
    older: z.array(LocalDate),
    included: z.boolean(),
    meaning: z.string().nullable(),
  }),
};

/**
 * POST /api/train/import. Every outcome names itself, as a publish does, and the body stays
 * unknown here because the route reports every problem in it. Deleted at cutover with
 * src/server/import.ts.
 */
export const ImportAnswer = z.discriminatedUnion('status', [
  /** 200. A listed conflict was skipped, and everything else landed. */
  z.object({ status: z.literal('imported'), ...ImportedFields }),
  /** 200. Nothing written. `targetShift` compares today's calorie targets with each choice about weigh-ins. */
  z.object({ status: z.literal('dry-run'), ...ImportedFields, phoneBehind: z.boolean(), targetShift: z.object({ byDefault: TargetShift, withOlder: TargetShift }) }),
  /** 422. Nothing written. The file failed its schema, or a document failed its own. */
  z.object({ status: z.literal('invalid'), problems: z.array(z.object({ path: z.string(), message: z.string() })) }),
  /** 422. Nothing written. A disagreement with Progress stands with no waiver, or a waiver names nothing that disagrees. */
  z.object({
    status: z.literal('unreconciled'),
    standing: z.array(z.object({ row: z.string(), field: z.string(), notion: z.string(), computed: z.string() })),
    staleWaivers: z.array(z.object({ row: z.string(), field: z.string() })),
  }),
  /** 422. Nothing written. These sessions are dated on or after the cutover in the body. */
  z.object({ status: z.literal('past_cutover'), cutover: LocalDate, dates: z.array(LocalDate) }),
  /** 409. Nothing written. No shell that can skip an unknown kind has reported in. */
  z.object({ status: z.literal('phone_behind') }),
]);
export type ImportAnswer = z.infer<typeof ImportAnswer>;

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
