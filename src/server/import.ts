/**
 * The one-time Notion import's door, apart from the coach's routes. Dated for deletion: the
 * cutover unit removes this file with src/domain/notionImport.ts. Logs name the route and status
 * only, because a body holds real training data.
 */
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { WeighIn } from '../domain/body.js';
import { PROFILE_ID } from '../domain/goals.js';
import type { Millis } from '../domain/ids.js';
import { NotionHistory, countsOf, datesFromCutover, importDocs, reconcile, targetShift, weighInPlan, type ImportDocs, type WeighInPlan } from '../domain/notionImport.js';
import type { ImportAnswer } from '../protocol.js';
import { log } from './log.js';
import type { DocStore, ImportKind, ImportOutcome } from './store.js';

export interface ImportDeps {
  readonly store: DocStore;
  readonly now: () => Millis;
}

/** The file is about 150 KB, so this only stops a wrong file. */
const MAX_BODY_BYTES = 1024 * 1024;

const IMPORT_STATUS = {
  imported: 200,
  'dry-run': 200,
  invalid: 422,
  unreconciled: 422,
  past_cutover: 422,
  phone_behind: 409,
} as const satisfies Readonly<Record<ImportAnswer['status'], ContentfulStatusCode>>;

const IMPORT_KINDS = ['session', 'performance', 'weighIn'] as const satisfies readonly ImportKind[];

const NO_WEIGH_INS = "fuel has no weigh-ins, so every Notion weigh-in counts as older and a default run writes none. Targets keep reading the profile's weight, and his first reading on the phone seeds the trend. With ?weighIns=1 the trend starts at the oldest Notion weigh-in instead, and every target from that date on reads it.";

/** RFC 9562 version 5 layout, so a session id is a valid UUID that depends only on its seed. */
export function uuidFrom(seed: string): string {
  const hash = createHash('sha1').update(`fuel-notion-import:${seed}`).digest('hex');
  const variant = ((Number.parseInt(hash.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function digestOf(docs: ImportDocs): string {
  return createHash('sha256').update(JSON.stringify(docs)).digest('hex');
}

const invalid = (path: string, message: string): ImportAnswer => ({ status: 'invalid', problems: [{ path, message }] });

function flagOn(name: string, value: string | undefined): { readonly ok: true; readonly on: boolean } | { readonly ok: false; readonly answer: ImportAnswer } {
  if (value === undefined || value === '1') return { ok: true, on: value === '1' };
  return { ok: false, answer: invalid(name, `expected ${name}=1 or no ${name} at all`) };
}

function bodyOf(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'not JSON' };
  }
}

/** Caught here because a thrown schema error would reach the error log, which must hold no training data. */
function documentsOf(history: NotionHistory, inFuel: readonly WeighIn[]): { readonly ok: true; readonly docs: ImportDocs; readonly plan: WeighInPlan } | { readonly ok: false; readonly answer: ImportAnswer } {
  try {
    return { ok: true, docs: importDocs(history, uuidFrom), plan: weighInPlan(history, inFuel) };
  } catch (err) {
    return { ok: false, answer: invalid('(documents)', err instanceof z.ZodError ? z.prettifyError(err) : 'a document failed its schema') };
  }
}

/** What the store would hold if these landed, with a phone's copy of a day winning, as it does in the write. */
function weighInsAfter(before: readonly WeighIn[], added: readonly WeighIn[], phoneHeld: ReadonlySet<string>): readonly WeighIn[] {
  const merged = new Map(before.map((weighIn) => [weighIn.id, weighIn]));
  for (const weighIn of added) if (!phoneHeld.has(weighIn.id)) merged.set(weighIn.id, weighIn);
  return [...merged.values()];
}

/** Synchronous from the first read to the last write, so a phone's sync cannot land between a comparison and what it allowed. */
function runImport({ store, now }: ImportDeps, text: string, dryRunFlag: string | undefined, weighInsFlag: string | undefined): ImportAnswer {
  const dryRunOn = flagOn('dryRun', dryRunFlag);
  if (!dryRunOn.ok) return dryRunOn.answer;
  const weighInsOn = flagOn('weighIns', weighInsFlag);
  if (!weighInsOn.ok) return weighInsOn.answer;
  const dryRun = dryRunOn.on;

  const body = bodyOf(text);
  if (!body.ok) return invalid('(body)', body.message);
  const parsed = NotionHistory.safeParse(body.value);
  if (!parsed.success) return { status: 'invalid', problems: parsed.error.issues.map((issue) => ({ path: z.core.toDotPath(issue.path), message: issue.message })) };
  const history = parsed.data;

  const result = reconcile(history);
  if (!result.clean) {
    return {
      status: 'unreconciled',
      standing: result.standing.map(({ row, field, notion, computed }) => ({ row, field, notion, computed })),
      staleWaivers: result.staleWaivers.map(({ row, field }) => ({ row, field })),
    };
  }

  const inFuel = store.liveDocs('weighIn').map((row) => row.doc);
  const built = documentsOf(history, inFuel);
  if (!built.ok) return built.answer;
  const { docs, plan } = built;
  const dates = datesFromCutover(docs, history.cutover);
  if (dates.length > 0) return { status: 'past_cutover', cutover: history.cutover, dates: [...dates] };

  const phoneBehind = store.stats().phoneBuild === null;
  if (!dryRun && phoneBehind) return { status: 'phone_behind' };

  const ctx = { now: now(), dryRun };
  const outcomes: Readonly<Record<ImportKind, ImportOutcome>> = {
    session: store.importKind('session', docs.sessions, ctx),
    performance: store.importKind('performance', docs.performances, ctx),
    weighIn: store.importKind('weighIn', weighInsOn.on ? [...plan.newer, ...plan.older] : plan.newer, ctx),
  };
  const count = (read: (outcome: ImportOutcome) => readonly string[]) => ({ session: read(outcomes.session).length, performance: read(outcomes.performance).length, weighIn: read(outcomes.weighIn).length });
  const listed = (read: (outcome: ImportOutcome) => readonly string[]) => IMPORT_KINDS.flatMap((kind) => read(outcomes[kind]).map((id) => ({ kind, id })));
  const fields = {
    digest: digestOf(docs),
    inFile: countsOf(docs),
    written: count((outcome) => outcome.written),
    unchanged: count((outcome) => outcome.unchanged),
    conflicts: listed((outcome) => outcome.conflicts),
    orphans: listed((outcome) => outcome.orphans),
    weighIns: {
      firstInFuel: plan.firstInFuel,
      newer: plan.newer.map((weighIn) => weighIn.date),
      older: plan.older.map((weighIn) => weighIn.date),
      included: weighInsOn.on,
      meaning: plan.firstInFuel === null ? NO_WEIGH_INS : null,
    },
  };
  if (!dryRun) return { status: 'imported', ...fields };

  const facts = {
    goals: store.liveDocs('goal').map((row) => row.doc),
    profile: store.liveDocs('profile').find((row) => row.doc.id === PROFILE_ID)?.doc,
    entries: store.liveDocs('entry').map((row) => row.doc),
    workouts: store.liveDocs('workout').map((row) => row.doc),
    before: inFuel,
  };
  const phoneHeld = new Set(store.importKind('weighIn', [...plan.newer, ...plan.older], ctx).conflicts);
  const shiftTo = (added: readonly WeighIn[]) => {
    const { days, largest } = targetShift({ ...facts, after: weighInsAfter(inFuel, added, phoneHeld) });
    return { days: [...days], largest };
  };
  return { status: 'dry-run', ...fields, phoneBehind, targetShift: { byDefault: shiftTo(plan.newer), withOlder: shiftTo([...plan.newer, ...plan.older]) } };
}

export function mountImport(app: Hono, deps: ImportDeps): void {
  const answer = (c: Context, result: ImportAnswer) => {
    log('import', { route: 'import', status: result.status });
    return c.json(result, IMPORT_STATUS[result.status]);
  };

  app.post(
    '/api/train/import',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => answer(c, invalid('(body)', `over ${MAX_BODY_BYTES} bytes`)) }),
    async (c) => {
      const text = await c.req.text();
      return answer(c, runImport(deps, text, c.req.query('dryRun'), c.req.query('weighIns')));
    },
  );
}
