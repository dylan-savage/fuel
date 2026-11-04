import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openReplica } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { lastTimesView } from '../src/client/views.js';
import { weighInId, type WeighIn } from '../src/domain/body.js';
import { PROFILE_ID, goalId, type Goal, type Profile } from '../src/domain/goals.js';
import { WorkoutId } from '../src/domain/ids.js';
import type { Kind } from '../src/domain/kinds.js';
import { liftBook } from '../src/domain/lifts.js';
import { NotionHistory, importDocs } from '../src/domain/notionImport.js';
import { lastSwapAt, lastTimeOf, sessionsDone, typedLine } from '../src/domain/progress.js';
import { ImportAnswer, SyncReply, type SyncRequest } from '../src/protocol.js';
import { uuidFrom } from '../src/server/import.js';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, newClientId, newEntryId, request, workout } from './fixtures.js';
import { day, lift, ms, noFoods, noonOf } from './training.fixtures.js';

const MONDAY = '2030-03-04';
const FRIDAY = '2030-03-08';
const CUTOVER = '2030-04-01';

const lb = (amount: number, reps: number) => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'total', reps } });

const pushDay = {
  label: 'Mon, Push',
  key: 'push',
  weekday: 1,
  date: MONDAY,
  pageId: 'page-1',
  pageEditedAt: '2030-03-04T18:00:00.000Z',
  morningWeightLb: 180,
  exercises: [
    { done: 'Bench press', target: { sets: 2, reps: { min: 8, max: 10 } }, sets: [lb(100, 10), lb(100, 8)] },
    { done: 'Incline press', planned: 'Row', sets: [lb(60, 10)], note: 'Rack was taken.' },
  ],
  skipped: [],
};
const blankDay = { label: 'Wed, Pull', key: 'pull', weekday: 3, date: '2030-03-06', pageId: 'page-3', pageEditedAt: '2030-03-06T18:00:00.000Z', morningWeightLb: 184, exercises: [], skipped: [] };
const swimDay = { label: 'Fri, Legs', key: 'legs', weekday: 5, date: FRIDAY, pageId: 'page-2', pageEditedAt: '2030-03-03T18:00:00.000Z', exercises: [], skipped: [], cardioOnly: 'The week row says Friday was a swim.' };

const progressRow = (exercise: string, topLb: number, volume: number, e1rm: number) => ({ entry: `${exercise}, Mar 4`, exercise, day: 'Mon, Push', monday: MONDAY, topLb, volume, e1rm, reps: '10', keyLift: false });

const FILE = {
  capturedAt: '2030-03-20',
  cutover: CUTOVER,
  dateAssumption: 'Monday plus the planned weekday.',
  names: { 'Bench press': 'bench-press', 'Incline press': 'incline-press', Row: 'row' },
  weeks: [{ monday: MONDAY, days: [pushDay, blankDay, swimDay] }],
  progress: [progressRow('Bench press', 100, 1800, 133.33), progressRow('Incline press', 60, 600, 80)],
  weekRows: [{ week: 'Week of Mar 4', monday: MONDAY, current: false, sessionsDone: 2, notes: 'Friday was a swim.' }],
  bodyWeight: [
    { entry: 'Mon Mar 4', date: MONDAY, lb: 180 },
    { entry: 'Wed Mar 6', date: '2030-03-06', lb: 184 },
  ],
  waivers: [],
};

const docsOf = (file: unknown = FILE) => importDocs(NotionHistory.parse(file), uuidFrom);

const onlyDocs = () => {
  const { sessions, performances } = docsOf();
  const [pushSession, swimSession] = sessions;
  const [benchRow, swapRow] = performances;
  if (pushSession === undefined || swimSession === undefined || benchRow === undefined || swapRow === undefined) throw new Error('the file holds two sessions and two performances');
  return { pushSession, swimSession, benchRow, swapRow };
};

type PhoneWrite = { readonly op: 'put'; readonly kind: Kind; readonly docId: string; readonly doc: unknown } | { readonly op: 'delete'; readonly kind: Kind; readonly docId: string };

const Row = z.object({ kind: z.string(), id: z.string(), rev: z.number(), body: z.string().nullable(), written_by: z.string(), written_at: z.number() });

const stores: DocStore[] = [];
let stdout: ReturnType<typeof spyOnStdout>;
const spyOnStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

beforeEach(() => {
  stdout = spyOnStdout();
});
afterEach(() => {
  stdout.mockRestore();
  for (const s of stores.splice(0)) s.close();
});

/** A real store on a file, so a test can read the bytes under it, and an app whose clock sits after the file. */
function setup(options: { readonly phone?: boolean } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'fuel-import-')), 'fuel.db');
  const store = openStore(path);
  stores.push(store);
  const app = buildApp({ store, foods: noFoods, ai: null, staticDir: '.', now: () => noonOf('2030-03-20') });
  const phone = newClientId();
  const state = { mutation: 0 };
  /** The phone's real write path, so each document lands written by its client id. */
  const phonePushes = (mutations: readonly PhoneWrite[]) => {
    const wire = mutations.map((m) => ({ ...m, id: (state.mutation += 1) }));
    return app.request('/api/sync', { method: 'POST', body: JSON.stringify({ ...request(phone, []), mutations: wire }) });
  };
  if (options.phone ?? true) store.sync({ ...request(newClientId(), []), build: 'abc-1' }, { now: ms(77), userAgent: null });

  const send = async (query = '', body: BodyInit = JSON.stringify(FILE)) => {
    const res = await app.request(`/api/train/import${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { http: res.status, answer: ImportAnswer.parse(await res.json()) };
  };
  const rows = () => {
    const db = new Database(path, { readonly: true });
    try {
      return z.array(Row).parse(db.prepare('SELECT kind, id, rev, body, written_by, written_at FROM doc ORDER BY rev').all());
    } finally {
      db.close();
    }
  };
  return { store, app, send, rows, phonePushes };
}

function landed(answer: ImportAnswer) {
  if (answer.status !== 'imported' && answer.status !== 'dry-run') throw new Error(`nothing landed: ${answer.status}`);
  return answer;
}

function dryRun(answer: ImportAnswer) {
  if (answer.status !== 'dry-run') throw new Error(`not a dry run: ${answer.status}`);
  return answer;
}

describe('POST /api/train/import', () => {
  it('answers a dry run with what it would write, and writes nothing', async () => {
    const { send, rows, store } = setup();
    const { http, answer } = await send('?dryRun=1');
    expect(http).toBe(200);
    expect(landed(answer)).toMatchObject({ status: 'dry-run', phoneBehind: false, inFile: { sessions: 2, performances: 2, sets: 3, lifts: 2 }, written: { session: 2, performance: 2, weighIn: 0 }, unchanged: { session: 0, performance: 0, weighIn: 0 }, conflicts: [], orphans: [] });
    expect(rows()).toEqual([]);
    expect(store.stats().rev).toBe(0);
  });

  it('stores the documents as the file builds them, written by import, at sync-ordered revs', async () => {
    const { send, rows } = setup();
    const { http, answer } = await send();
    expect(http).toBe(200);
    expect(landed(answer)).toMatchObject({ status: 'imported', written: { session: 2, performance: 2, weighIn: 0 }, conflicts: [] });
    const { sessions, performances } = docsOf();
    expect(rows().map((row) => [row.kind, row.id, row.written_by, row.body])).toEqual([...sessions.map((s) => ['session', s.id, 'import', JSON.stringify(s)]), ...performances.map((p) => ['performance', p.id, 'import', JSON.stringify(p)])]);
    expect(rows().map((row) => row.rev)).toEqual([1, 2, 3, 4]);
  });

  it('writes nothing on a re-run', async () => {
    const { send, rows } = setup();
    await send();
    const before = rows();
    const { answer } = await send();
    expect(landed(answer)).toMatchObject({ written: { session: 0, performance: 0, weighIn: 0 }, unchanged: { session: 2, performance: 2, weighIn: 0 }, conflicts: [] });
    expect(rows()).toEqual(before);
  });

  it('resumes after dying between two kinds, writing only the kind that had not landed', async () => {
    const { send, store, rows } = setup();
    store.importKind('session', docsOf().sessions, { now: ms(1), dryRun: false });
    const sessionsLanded = rows();
    const { answer } = await send();
    expect(landed(answer)).toMatchObject({ written: { session: 0, performance: 2, weighIn: 0 }, unchanged: { session: 2, performance: 0, weighIn: 0 } });
    expect(rows().slice(0, 2)).toEqual(sessionsLanded);
  });

  it('rewrites a document the import last wrote when the file has changed it, moving only that one', async () => {
    const { send, rows } = setup();
    await send();
    const before = rows();
    const changed = { ...FILE, weeks: [{ monday: MONDAY, days: [{ ...pushDay, note: 'Added on a re-export.' }, blankDay, swimDay] }] };
    const { answer } = await send('', JSON.stringify(changed));
    expect(landed(answer)).toMatchObject({ written: { session: 1, performance: 0, weighIn: 0 }, unchanged: { session: 1, performance: 2, weighIn: 0 } });
    const after = rows();
    const { pushSession } = onlyDocs();
    expect(after.find((row) => row.id === pushSession.id)?.rev).toBe(5);
    expect(after.find((row) => row.id === pushSession.id)?.written_by).toBe('import');
    expect(after.filter((row) => row.id !== pushSession.id)).toEqual(before.filter((row) => row.id !== pushSession.id));
  });

  it('lists a document a phone edited as a conflict and leaves it alone', async () => {
    const { send, rows, phonePushes } = setup();
    await send();
    const { benchRow } = onlyDocs();
    const edited = { ...benchRow, sets: [lb(105, 10)] };
    await phonePushes([{ op: 'put', kind: 'performance', docId: benchRow.id, doc: edited }]);
    const before = rows();
    const { http, answer } = await send();
    expect(http).toBe(200);
    expect(landed(answer)).toMatchObject({ written: { session: 0, performance: 0, weighIn: 0 }, unchanged: { session: 2, performance: 1, weighIn: 0 }, conflicts: [{ kind: 'performance', id: benchRow.id }] });
    expect(rows()).toEqual(before);
    expect(z.looseObject({ sets: z.array(z.unknown()) }).parse(JSON.parse(rows().find((row) => row.id === benchRow.id)?.body ?? 'null')).sets).toEqual([lb(105, 10)]);
  });

  it('dry-runs the same conflict', async () => {
    const { send, phonePushes } = setup();
    await send();
    const { swimSession } = onlyDocs();
    await phonePushes([{ op: 'put', kind: 'session', docId: swimSession.id, doc: { ...swimSession, note: 'It was a run.' } }]);
    expect(landed((await send('?dryRun=1')).answer).conflicts).toEqual([{ kind: 'session', id: swimSession.id }]);
  });

  it('keeps a document a phone deleted deleted, listed as a conflict', async () => {
    const { send, rows, phonePushes } = setup();
    await send();
    const { swapRow } = onlyDocs();
    await phonePushes([{ op: 'delete', kind: 'performance', docId: swapRow.id }]);
    const { answer } = await send();
    expect(landed(answer).conflicts).toEqual([{ kind: 'performance', id: swapRow.id }]);
    expect(rows().find((row) => row.id === swapRow.id)?.body).toBeNull();
  });

  it('counts a phone copy of the same bytes as unchanged, as after a backup restore re-pushes everything', async () => {
    const { send, phonePushes } = setup();
    await send();
    const { benchRow } = onlyDocs();
    await phonePushes([{ op: 'put', kind: 'performance', docId: benchRow.id, doc: benchRow }]);
    expect(landed((await send()).answer)).toMatchObject({ written: { session: 0, performance: 0, weighIn: 0 }, conflicts: [] });
  });

  it('lists what an earlier import wrote and this file no longer holds, leaving it in place', async () => {
    const { send, rows } = setup();
    await send();
    const { swimSession } = onlyDocs();
    const without = { ...FILE, weeks: [{ monday: MONDAY, days: [pushDay, blankDay] }], weekRows: [{ week: 'Week of Mar 4', monday: MONDAY, current: false, sessionsDone: 1, notes: null }] };
    const { answer } = await send('', JSON.stringify(without));
    expect(landed(answer).orphans).toEqual([{ kind: 'session', id: swimSession.id }]);
    expect(rows().find((row) => row.id === swimSession.id)?.body).not.toBeNull();
  });

  it('answers 422 with the list while a disagreement stands or a waiver is stale, writing nothing', async () => {
    const { send, rows } = setup();
    const wrong = { ...FILE, progress: [progressRow('Bench press', 100, 1801, 133.33), progressRow('Incline press', 60, 600, 80)] };
    const standing = await send('', JSON.stringify(wrong));
    expect(standing.http).toBe(422);
    expect(standing.answer).toEqual({ status: 'unreconciled', standing: [{ row: `${MONDAY} Mon, Push bench-press`, field: 'volume', notion: '1801', computed: '1800' }], staleWaivers: [] });

    const stale = await send('', JSON.stringify({ ...FILE, waivers: [{ row: 'nothing', field: 'volume', reason: 'An old excuse.' }] }));
    expect(stale.http).toBe(422);
    expect(stale.answer).toEqual({ status: 'unreconciled', standing: [], staleWaivers: [{ row: 'nothing', field: 'volume' }] });
    expect(rows()).toEqual([]);
  });

  it.each<[string, () => string, string | RegExp]>([
    ['a misspelled field at any depth', () => JSON.stringify({ ...FILE, weeks: [{ monday: MONDAY, days: [{ ...pushDay, skiped: [] }] }] }), 'weeks[0].days[0]'],
    ['a missing cutover', () => JSON.stringify({ ...FILE, cutover: undefined }), 'cutover'],
    ['a body that is not JSON', () => '{"weeks": ', '(body)'],
    ['a document its own schema refuses', () => JSON.stringify({ ...FILE, weeks: [{ monday: MONDAY, days: [{ ...pushDay, exercises: [{ ...pushDay.exercises[0], sets: [{ ...lb(100, 10), note: 'x'.repeat(281) }, lb(100, 8)] }, pushDay.exercises[1]] }, blankDay, swimDay] }] }), '(documents)'],
  ])('answers 422 invalid on %s, writing nothing', async (_name, body, path) => {
    const { send, rows } = setup();
    const { http, answer } = await send('', body());
    expect(http).toBe(422);
    if (answer.status !== 'invalid') throw new Error(`expected invalid, got ${answer.status}`);
    expect(answer.problems.map((problem) => problem.path).join(' ')).toMatch(path);
    expect(rows()).toEqual([]);
  });

  it.each([['?dryRun=yes'], ['?weighIns=true']])('refuses a flag spelled %s rather than ignoring it', async (query) => {
    const { send, rows } = setup();
    const { http, answer } = await send(query);
    expect(http).toBe(422);
    expect(answer.status).toBe('invalid');
    expect(rows()).toEqual([]);
  });

  it('refuses the whole file when a session is dated on or after its cutover, naming the date', async () => {
    const { send, rows } = setup();
    const onIt = await send('', JSON.stringify({ ...FILE, cutover: FRIDAY }));
    expect(onIt.http).toBe(422);
    expect(onIt.answer).toEqual({ status: 'past_cutover', cutover: FRIDAY, dates: [FRIDAY] });
    expect((await send('?dryRun=1', JSON.stringify({ ...FILE, cutover: MONDAY }))).answer).toEqual({ status: 'past_cutover', cutover: MONDAY, dates: [MONDAY, FRIDAY] });
    expect(rows()).toEqual([]);
    expect((await send('', JSON.stringify({ ...FILE, cutover: '2030-03-09' }))).answer.status).toBe('imported');
  });

  it('refuses a real run until a phone has reported its build, and a dry run says so', async () => {
    const { send, rows } = setup({ phone: false });
    const refused = await send();
    expect(refused.http).toBe(409);
    expect(refused.answer).toEqual({ status: 'phone_behind' });
    expect(rows()).toEqual([]);
    expect(landed((await send('?dryRun=1')).answer)).toMatchObject({ status: 'dry-run', phoneBehind: true });
  });

  it('logs the route and status and nothing from the body', async () => {
    const { send } = setup();
    await send();
    const lines = stdout.mock.calls.map(([line]) => String(line));
    expect(lines.join('')).not.toContain('Bench press');
    expect(lines.filter((line) => line.includes('"event":"import"')).map((line) => Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(line))))).toEqual([['at', 'event', 'route', 'status']]);
  });
});

describe('what the import cannot reach', () => {
  const food = entry(newEntryId(), 450, MONDAY);

  it('writes no workout and leaves every diary document byte-identical', async () => {
    const { send, rows, store, phonePushes } = setup();
    const walk = workout(WorkoutId.parse(randomUUID()), 80, FRIDAY);
    await phonePushes([
      { op: 'put', kind: 'entry', docId: food.id, doc: food },
      { op: 'put', kind: 'workout', docId: walk.id, doc: walk },
    ]);
    const notTraining = () => rows().filter((row) => row.kind !== 'session' && row.kind !== 'performance');
    const before = notTraining();
    expect(before).toHaveLength(2);

    await send('?dryRun=1');
    await send('');
    await send('');
    expect(notTraining()).toEqual(before);
    expect(store.liveDocs('workout').map((row) => row.doc)).toEqual([walk]);
    expect(store.liveDocs('session')).toHaveLength(2);
  });

  it('has no parameter for one, by type', () => {
    const { store } = setup();
    // @ts-expect-error The import writes sessions, performances and weigh-ins, and no other kind.
    expect(() => store.importKind('workout', [], { now: ms(1), dryRun: true })).not.toThrow();
    // @ts-expect-error Nor a program, which only the coach writes.
    expect(() => store.importKind('program', [], { now: ms(1), dryRun: true })).not.toThrow();
  });
});

describe('a cardio-only day', () => {
  it('counts on the coach read with no sets and its note', async () => {
    const { send, app } = setup();
    await send();
    const { swimSession } = onlyDocs();
    const res = await app.request('/api/train/snapshot?weeks=52');
    const Snapshot = z.looseObject({ weeks: z.array(z.looseObject({ monday: z.string(), sessionsDone: z.number(), sessions: z.array(z.looseObject({ id: z.string(), exercises: z.array(z.unknown()), phase: z.string() })) })), notes: z.array(z.looseObject({ text: z.string() })) });
    const { weeks, notes } = Snapshot.parse(await res.json());
    const week = weeks.find((w) => w.monday === MONDAY);
    expect(week?.sessionsDone).toBe(2);
    expect(week?.sessions.find((s) => s.id === swimSession.id)).toMatchObject({ exercises: [], phase: 'imported' });
    expect(notes.map((note) => note.text)).toContain('The week row says Friday was a swim.');
  });
});

describe('the weigh-ins', () => {
  const stored = (date: string, kg: number): WeighIn => ({ id: weighInId(day(date)), date: day(date), kg, loggedAt: at(5) });

  it('skips all of them by default when fuel has none, says what that means, and writes them under ?weighIns=1', async () => {
    const { send, store } = setup();
    const { answer } = await send();
    expect(landed(answer)).toMatchObject({ written: { weighIn: 0 }, weighIns: { firstInFuel: null, newer: [], older: [MONDAY, '2030-03-06'], included: false } });
    expect(landed(answer).weighIns.meaning).toMatch(/no weigh-ins/);
    expect(store.liveDocs('weighIn')).toEqual([]);

    const included = await send('?weighIns=1');
    expect(landed(included.answer)).toMatchObject({ written: { session: 0, performance: 0, weighIn: 2 }, weighIns: { included: true } });
    expect(store.liveDocs('weighIn').map((row) => row.doc.date)).toEqual([MONDAY, '2030-03-06']);
  });

  it('skips only those older than fuel\'s first, and leaves the first alone', async () => {
    const { send, store, phonePushes } = setup();
    const first = stored('2030-03-05', 83);
    await phonePushes([{ op: 'put', kind: 'weighIn', docId: first.id, doc: first }]);
    const { answer } = await send();
    expect(landed(answer)).toMatchObject({ written: { weighIn: 1 }, weighIns: { firstInFuel: '2030-03-05', newer: ['2030-03-06'], older: [MONDAY], meaning: null } });
    expect(store.liveDocs('weighIn').map((row) => row.doc.date)).toEqual(['2030-03-05', '2030-03-06']);
  });

  it('treats a day the phone already holds as a conflict, keeping his reading', async () => {
    const { send, store, phonePushes } = setup();
    const own = stored('2030-03-06', 83);
    await phonePushes([{ op: 'put', kind: 'weighIn', docId: own.id, doc: own }]);
    const { answer } = await send('?weighIns=1');
    expect(landed(answer).conflicts).toEqual([{ kind: 'weighIn', id: own.id }]);
    expect(store.liveDocs('weighIn').find((row) => row.doc.id === own.id)?.doc.kg).toBe(83);
  });

  it('is unchanged on a re-run after including them, now that the oldest is fuel\'s first', async () => {
    const { send } = setup();
    await send('?weighIns=1');
    expect(landed((await send()).answer)).toMatchObject({ written: { weighIn: 0 }, unchanged: { weighIn: 2 }, weighIns: { firstInFuel: MONDAY, older: [] } });
  });
});

describe('the dry run\'s target shift', () => {
  const profile: Profile = { id: PROFILE_ID, sex: 'male', birthDate: day('1990-01-01'), heightCm: 180, weightKg: 80 };
  const goal: Goal = { id: goalId(day('2030-03-01')), effectiveFrom: day('2030-03-01'), policy: { kind: 'activity-level', level: 'moderate' }, kgPerWeek: 0, macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 } };
  const onDate = (date: string): PhoneWrite => {
    const doc = entry(newEntryId(), 300, date);
    return { op: 'put', kind: 'entry', docId: doc.id, doc };
  };
  const seeded = async () => {
    const context = setup();
    await context.phonePushes([{ op: 'put', kind: 'profile', docId: profile.id, doc: profile }, { op: 'put', kind: 'goal', docId: goal.id, doc: goal }, onDate('2030-03-03'), onDate('2030-03-05'), onDate('2030-03-07')]);
    return context;
  };

  it('prints each diary day with a goal and the largest change including them would cause, through the real budget', async () => {
    const { send, rows } = await seeded();
    const before = rows();
    const { targetShift } = dryRun((await send('?dryRun=1')).answer);
    expect(targetShift.byDefault.largest?.change).toBe(0);
    expect(targetShift.withOlder.days.map((d) => [d.date, d.change])).toEqual([
      // Before the first Notion weigh-in, the profile's weight either way.
      ['2030-03-03', 0],
      // 180 lb seeds the trend, 1.65 kg above the profile, at 10 kcal per kg and the 1.55 multiplier.
      ['2030-03-05', 25],
      // 184 lb moves the trend a tenth of the way, about 0.18 kg more.
      ['2030-03-07', 28],
    ]);
    expect(targetShift.withOlder.largest).toMatchObject({ date: '2030-03-07', change: 28 });
    expect(rows()).toEqual(before);
  });

  it('answers no largest change with no diary day, no goal or no profile, because no target exists to move', async () => {
    const { send, phonePushes } = setup();
    expect(dryRun((await send('?dryRun=1')).answer).targetShift.withOlder).toEqual({ days: [], largest: null });
    await phonePushes([onDate('2030-03-05')]);
    expect(dryRun((await send('?dryRun=1')).answer).targetShift.withOlder).toEqual({ days: [], largest: null });
    await phonePushes([{ op: 'put', kind: 'goal', docId: goal.id, doc: goal }]);
    expect(dryRun((await send('?dryRun=1')).answer).targetShift.withOlder).toEqual({ days: [], largest: null });
  });

  it('leaves a manual target where it is', async () => {
    const { send, phonePushes } = await seeded();
    const manual: Goal = { ...goal, kcalOverride: 2000 };
    await phonePushes([{ op: 'put', kind: 'goal', docId: manual.id, doc: manual }]);
    const { targetShift } = dryRun((await send('?dryRun=1')).answer);
    expect(targetShift.withOlder.days.map((d) => d.change)).toEqual([0, 0, 0]);
  });

  it('keeps a reading the phone holds out of both comparisons', async () => {
    const { send, phonePushes } = await seeded();
    const own: WeighIn = { id: weighInId(day(MONDAY)), date: day(MONDAY), kg: 80, loggedAt: at(5) };
    await phonePushes([{ op: 'put', kind: 'weighIn', docId: own.id, doc: own }]);
    const { targetShift, conflicts } = dryRun((await send('?dryRun=1&weighIns=1')).answer);
    expect(conflicts).toEqual([{ kind: 'weighIn', id: own.id }]);
    expect(targetShift.byDefault.days.find((d) => d.date === '2030-03-05')?.change, 'his reading seeds the trend either way').toBe(0);
  });
});

describe('the phone', () => {
  it('pulls the imported documents, and the last-time read answers from them', async () => {
    const { send, app, store } = setup();
    await send();
    const { replica, port } = await openReplica({ name: 'import-pull', indexedDB: new IDBFactory(), IDBKeyRange, build: 'abc-1' });
    const transport: Transport = async (req: SyncRequest) => SyncReply.parse(await (await app.request('/api/sync', { method: 'POST', body: JSON.stringify(req) })).json());
    await syncRounds(port, transport);

    const { pushSession, swimSession, benchRow, swapRow } = onlyDocs();
    const before = day('2030-03-11');
    const book = liftBook([]);
    expect(await replica.read.get('session', swimSession.id)).toEqual(swimSession);
    expect(await replica.read.performancesOfSession(swimSession.id)).toEqual([]);
    expect(await replica.read.performancesOfSession(pushSession.id)).toEqual([benchRow, swapRow]);

    const bench = lastTimeOf({ lift: lift('bench-press'), book, before, rows: await lastTimesView(replica.read, [lift('bench-press')], before) });
    expect(bench).toEqual(benchRow);
    expect(typedLine(bench?.sets ?? [])).toBe('100 lb x 10/8');

    const row = await lastTimesView(replica.read, [lift('row')], before);
    expect(lastSwapAt({ lift: lift('row'), book, before, rows: row })).toMatchObject({ date: MONDAY, liftId: 'incline-press', line: '60 lb x 10' });

    const sessions = await replica.read.between('session', day(MONDAY), day('2030-03-10'));
    expect(sessionsDone(sessions, [benchRow, swapRow]).map((s) => s.id).toSorted()).toEqual([pushSession.id, swimSession.id].toSorted());
    expect(store.liveDocs('session')).toHaveLength(2);
    replica.close();
  });

  it('pushes its later edit back over an imported document, which the next import then leaves alone', async () => {
    const { send, app, rows } = setup();
    await send();
    const { replica, port } = await openReplica({ name: 'import-edit', indexedDB: new IDBFactory(), IDBKeyRange, build: 'abc-1' });
    const transport: Transport = async (req: SyncRequest) => SyncReply.parse(await (await app.request('/api/sync', { method: 'POST', body: JSON.stringify(req) })).json());
    await syncRounds(port, transport);

    const { swimSession } = onlyDocs();
    await replica.commit([{ op: 'put', kind: 'session', doc: { ...swimSession, note: 'It was a run.' } }]);
    await syncRounds(port, transport);

    const { answer } = await send();
    expect(landed(answer).conflicts).toEqual([{ kind: 'session', id: swimSession.id }]);
    expect(rows().find((row) => row.id === swimSession.id)?.written_by).not.toBe('import');
    replica.close();
  });
});
