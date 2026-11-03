/**
 * The coach's door, mounted by buildApp under the same perimeter as /api/sync and with its same
 * lack of auth. The rules are the domain's. Logs name the route and status only, because a body
 * holds real training data.
 */
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { SNAPSHOT_WEEKS, checkPublish, snapshotOf, type CoachSnapshot, type Problem, type PublishVerdict, type TrainDocs } from '../domain/coach.js';
import { LocalDate, type Millis } from '../domain/ids.js';
import { isRecord } from '../domain/strict.js';
import { Rev, type PublishAnswer } from '../protocol.js';
import { localDay } from './backup.js';
import { log } from './log.js';
import type { DocStore } from './store.js';

export interface TrainDeps {
  readonly store: DocStore;
  readonly now: () => Millis;
}

/** A version is about 30 KB, so this only stops a wrong file. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WEEKS = 52;
const Weeks = z.coerce.number().int().min(1).max(MAX_WEEKS).default(SNAPSHOT_WEEKS);

const PUBLISH_STATUS = {
  published: 200,
  unchanged: 200,
  'dry-run': 200,
  invalid: 422,
  frozen: 409,
  stale: 409,
  phone_behind: 409,
} as const satisfies Readonly<Record<PublishAnswer['status'], ContentfulStatusCode>>;

const clockAt = (now: Millis) => ({ today: LocalDate.parse(localDay(new Date(now))), now });

const refused = (path: string, message: string): PublishAnswer => ({ status: 'invalid', problems: [{ code: 'shape', path, message }] satisfies Problem[] });

function jsonObject(text: string): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { ok: true, body: value } : { ok: false, message: 'expected a JSON object' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'not JSON' };
  }
}

const problemsIn = (verdict: PublishVerdict): readonly Problem[] => (verdict.status === 'invalid' || verdict.status === 'frozen' ? verdict.problems : []);

/**
 * Synchronous from the first read to the write, so a phone's sync cannot land between a check
 * and what it allowed. The verdict answers unchanged before anything else can refuse, because a
 * retry after a lost response must succeed however much the plan or the calendar has moved since.
 */
function publish({ store, now }: TrainDeps, text: string, dryRunFlag: string | undefined): PublishAnswer {
  if (dryRunFlag !== undefined && dryRunFlag !== '1') return refused('dryRun', 'expected dryRun=1 or no dryRun at all');
  const parsed = jsonObject(text);
  if (!parsed.ok) return refused('(body)', parsed.message);
  const { basedOnRev: rawRev, ...draft } = parsed.body;
  const basedOnRev = Rev.safeParse(rawRev);
  const clock = clockAt(now());
  const verdict = checkPublish(
    draft,
    store.liveDocs('program').map((version) => version.doc),
    clock,
  );
  if (!basedOnRev.success) return { status: 'invalid', problems: [{ code: 'shape', path: 'basedOnRev', message: 'expected the basedOnRev from the read' }, ...problemsIn(verdict)] };

  const currentRev = store.highestRev('program');
  switch (verdict.status) {
    case 'invalid':
      return { status: 'invalid', problems: [...verdict.problems] };
    case 'frozen':
      return { status: 'frozen', id: verdict.id, earliestEffectiveFrom: verdict.earliestEffectiveFrom, problems: [...verdict.problems] };
    case 'unchanged':
      return { status: 'unchanged', id: verdict.id, rev: currentRev };
    case 'valid': {
      if (currentRev > basedOnRev.data) return { status: 'stale', basedOnRev: basedOnRev.data, currentRev };
      const phoneBehind = store.stats().phoneBuild === null;
      if (dryRunFlag !== undefined) return { status: 'dry-run', id: verdict.program.id, diff: [...verdict.diff], phoneBehind };
      if (phoneBehind) return { status: 'phone_behind' };
      const stored = store.writeProgram(verdict.program, clock);
      return { status: 'published', id: stored.doc.id, rev: Rev.parse(stored.rev) };
    }
  }
}

function coachDocs(store: DocStore): TrainDocs {
  const docsOnly = <T>(rows: readonly { readonly doc: T }[]) => rows.map((row) => row.doc);
  return {
    programRev: store.highestRev('program'),
    programs: store.liveDocs('program'),
    sessions: store.liveDocs('session'),
    performances: store.liveDocs('performance'),
    trainingNotes: docsOnly(store.liveDocs('trainingNote')),
    weighIns: docsOnly(store.liveDocs('weighIn')),
    entries: docsOnly(store.liveDocs('entry')),
    workouts: docsOnly(store.liveDocs('workout')),
  };
}

export function mountTrain(app: Hono, deps: TrainDeps): void {
  const { store, now } = deps;

  const answerPublish = (c: Context, answer: PublishAnswer) => {
    log('train', { route: 'publish', status: answer.status });
    return c.json(answer, PUBLISH_STATUS[answer.status]);
  };

  app.get('/api/train/snapshot', (c) => {
    const weeks = Weeks.safeParse(c.req.query('weeks'));
    if (!weeks.success) {
      log('train', { route: 'snapshot', status: 'bad_weeks' });
      return c.json({ error: `weeks must be 1 to ${MAX_WEEKS}` }, 400);
    }
    const snapshot = snapshotOf(coachDocs(store), { ...clockAt(now()), phoneLastSyncAt: store.stats().phoneBuild?.at ?? null }, weeks.data);
    log('train', { route: 'snapshot', status: 'ok' });
    return c.json(snapshot satisfies CoachSnapshot);
  });

  app.post(
    '/api/train/publish',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => answerPublish(c, refused('(body)', `over ${MAX_BODY_BYTES} bytes`)) }),
    async (c) => {
      const text = await c.req.text();
      return answerPublish(c, publish(deps, text, c.req.query('dryRun')));
    },
  );
}
