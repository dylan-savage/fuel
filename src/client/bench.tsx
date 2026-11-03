/**
 * Temporary, and reverted after the measurement. Times on the phone what training unit 5 gates
 * on, over invented data in a throwaway database. It never imports sync.ts, so nothing here can
 * reach the server, and it never opens the database named fuel.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SessionId, addDays, mondayOf } from '../domain/ids.js';
import type { Kind } from '../domain/kinds.js';
import { LiftId, SlotId, liftBook, performanceId } from '../domain/lifts.js';
import { programId } from '../domain/program.js';
import { lastTimeOf, liftSeries } from '../domain/progress.js';
import { Rev } from '../protocol.js';
import { localDate, now } from './clock.js';
import { openReplica, type ReplicaReader } from './replica.js';
import { dayView, lastTimesView } from './views.js';

const DB_NAME = 'fuel-bench';
const SESSIONS = 1000;
const PER_SESSION = 10;
const DAYS_BETWEEN_SESSIONS = 1.825;
const HISTORY_DAYS = Math.round(SESSIONS * DAYS_BETWEEN_SESSIONS);
const LIFT_COUNT = 40;
const ENTRIES_TODAY = 12;
const SLOTS = 12;
const RUNS = 25;
/** What one pull from the server carries, so seeding runs the same parse and put as real history. */
const PULL_PAGE = 1000;
const DAY_OPEN_GATE_MS = 50;
const SET_STORED_GATE_MS = 50;

const TEXT = 'Invented text, long enough to weigh what a real cue or note weighs on the phone, and to clone like one when it is read back. ';

const today = localDate();
const liftIds = Array.from({ length: LIFT_COUNT }, (_, i) => LiftId.parse(`invented-lift-${i}`));
const book = liftBook(liftIds.map((id) => ({ id, name: id, aliases: [] })));

const liftAt = (i: number): LiftId => {
  const lift = liftIds[i % LIFT_COUNT];
  if (lift === undefined) throw new Error(`no lift at ${i}`);
  return lift;
};
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sessionIdOf = (index: number) => uuid(index + 1);
const twelveAt = (round: number) => Array.from({ length: SLOTS }, (_, i) => liftAt(round * SLOTS + i));

interface Seed {
  readonly kind: Kind;
  readonly id: string;
  readonly doc: unknown;
}

function programSeed(): Seed {
  const effectiveFrom = mondayOf(addDays(today, -7));
  const id = programId(effectiveFrom);
  const days = Array.from({ length: 5 }, (_, d) => ({
    key: `day-${d}`,
    label: `Invented day ${d}`,
    weekday: d + 1,
    minutes: 60,
    blocks: [
      { kind: 'checklist', id: `warm-${d}`, title: 'Warm up', items: ['Arm circles', 'Hip openers', 'Band pulls'] },
      ...Array.from({ length: 3 }, (_, b) => ({
        kind: 'lifts',
        id: `block-${d}-${b}`,
        title: `Superset ${b}`,
        restSeconds: 90,
        slots: Array.from({ length: 3 }, (_, s) => ({
          id: `slot-${d}-${b}-${s}`,
          liftId: liftAt(d * 9 + b * 3 + s),
          label: `Invented lift ${d}-${b}-${s}`,
          target: { sets: 3, reps: { min: 8, max: 10 } },
          swaps: [{ liftId: liftAt(d * 9 + b * 3 + s + 1), label: 'Invented swap' }],
          cue: TEXT,
        })),
      })),
    ],
  }));
  const doc = {
    id,
    effectiveFrom,
    days,
    lifts: liftIds.map((lift) => ({ id: lift, name: lift, aliases: [] })),
    weeklyMinimum: 3,
    notes: [{ title: 'This week', text: TEXT.repeat(4) }],
    standing: Array.from({ length: 4 }, (_, i) => ({ key: `rules-${i}`, title: `Invented rules ${i}`, text: TEXT.repeat(12) })),
    report: { title: 'Invented report', text: TEXT.repeat(24) },
    changes: Array.from({ length: 6 }, (_, i) => ({ target: `slot:day-0/slot-${i}`, why: TEXT })),
    publishedAt: now(),
  };
  return { kind: 'program', id, doc };
}

/** One session every 1.8 days for 5 years, with ten exercises each. One in twenty is a swap. */
function trainingSeeds(): readonly Seed[] {
  const planId = programId(mondayOf(addDays(today, -7)));
  const seeds: Seed[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const id = sessionIdOf(s);
    const date = addDays(today, -Math.round(s * DAYS_BETWEEN_SESSIONS));
    const startedAt = Date.now() - s * 157_680_000;
    seeds.push({
      kind: 'session',
      id,
      doc: { id, date, day: { key: `day-${s % 5}`, label: `Invented day ${s % 5}` }, programId: planId, startedAt, finishedAt: startedAt + 3_600_000, checked: [`warm-${s % 5}`] },
    });
    for (let p = 0; p < PER_SESSION; p++) {
      const index = s * PER_SESSION + p;
      const liftId = liftAt(index);
      const slotId = `s${p}`;
      const performance = performanceId(SessionId.parse(id), SlotId.parse(slotId), liftId);
      const set = (reps: number, at: number) => ({ load: { kind: 'weight', amount: 40 + (index % 30) * 5, unit: 'lb' }, reps: { kind: 'total', reps }, at: startedAt + p * 240_000 + at * 120_000 });
      seeds.push({
        kind: 'performance',
        id: performance,
        doc: {
          id: performance,
          sessionId: id,
          date,
          liftId,
          label: `Invented lift ${index % LIFT_COUNT}`,
          slotId,
          ...((s + p) % 20 === 0 ? { plannedLiftId: liftAt(index + 1) } : {}),
          target: { sets: 3, reps: { min: 8, max: 10 } },
          sets: [{ ...set(10, 0), warmup: true }, set(10, 1), set(9, 2), set(8, 3)],
        },
      });
    }
  }
  return seeds;
}

/** The goal, profile and weigh-ins make dayView walk its budget and trend, which it skips with no goal. */
function diarySeeds(): readonly Seed[] {
  const entries = Array.from({ length: ENTRIES_TODAY }, (_, i): Seed => {
    const id = uuid(1_000_000 + i);
    return {
      kind: 'entry',
      id,
      doc: {
        id,
        date: today,
        meal: i < 3 ? 'breakfast' : i < 6 ? 'lunch' : i < 9 ? 'dinner' : 'snacks',
        loggedAt: Date.now() + i,
        food: { name: `Invented food ${i}`, unit: 'portion', nutrients: { kcal: 150 + i, protein: 12, carbs: 20, fat: 5, fiber: 2, sugar: 3, sodium: 200 }, servings: [{ label: 'portion', amount: 1 }], origin: { kind: 'adhoc' } },
        quantity: { kind: 'amount', amount: 1 },
      },
    };
  });
  const weighIns = Array.from({ length: HISTORY_DAYS }, (_, i): Seed => {
    const date = addDays(today, -i);
    return { kind: 'weighIn', id: `w:${date}`, doc: { id: `w:${date}`, date, kg: 80 + Math.sin(i / 30), loggedAt: Date.now() - i * 86_400_000 } };
  });
  const from = addDays(today, -HISTORY_DAYS);
  return [
    ...entries,
    ...weighIns,
    { kind: 'profile', id: 'me', doc: { id: 'me', sex: 'male', birthDate: '1990-06-15', heightCm: 180, weightKg: 80 } },
    {
      kind: 'goal',
      id: `g:${from}`,
      doc: { id: `g:${from}`, effectiveFrom: from, policy: { kind: 'activity-level', level: 'moderate' }, kgPerWeek: -0.25, macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 } },
    },
  ];
}

type Opened = Awaited<ReturnType<typeof openReplica>>;

const openBench = (): Promise<Opened> => openReplica({ name: DB_NAME });

function deleteBenchDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(DB_NAME);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error ?? new Error(`could not delete ${DB_NAME}`));
  });
}

/** Lets the page paint between pieces of work, outside anything timed. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

async function weekReads(r: ReplicaReader): Promise<number> {
  const from = addDays(today, -6);
  const [program, sessions, performances] = await Promise.all([r.programOn(today), r.between('session', from, today), r.between('performance', from, today)]);
  if (program === undefined) throw new Error('no program in effect');
  return 1 + sessions.length + performances.length;
}

async function dayRead(r: ReplicaReader): Promise<number> {
  const view = await dayView(r, today);
  if (view.budget === null) throw new Error('dayView had no budget, so it skipped the trend');
  return view.summary.entries.length;
}

async function dayOpen(r: ReplicaReader): Promise<number> {
  const [entries, week] = await Promise.all([dayRead(r), weekReads(r)]);
  return entries + week;
}

/** Each returns how many documents it touched, because a measure that did nothing must fail, not look fast. */
interface Measure {
  readonly label: string;
  readonly gateMs?: number;
  /** A new connection first, which is what launching the app starts from. */
  readonly fresh?: true;
  run(opened: Opened, round: number): Promise<number>;
}

const DAY_OPEN: Measure = { label: 'Day open', gateMs: DAY_OPEN_GATE_MS, fresh: true, run: ({ replica }) => dayOpen(replica.read) };

const SET_STORED: Measure = {
  label: 'Set stored',
  gateMs: SET_STORED_GATE_MS,
  run: async ({ replica }, round) => {
    const slot = round % PER_SESSION;
    const id = performanceId(SessionId.parse(sessionIdOf(0)), SlotId.parse(`s${slot}`), liftAt(slot));
    const before = await replica.read.get('performance', id);
    if (before === undefined) throw new Error(`no performance ${id}`);
    await replica.commit([{ op: 'put', kind: 'performance', doc: { ...before, sets: [...before.sets, { load: { kind: 'weight', amount: 100, unit: 'lb' }, reps: { kind: 'total', reps: 8 }, at: now() }] } }]);
    return 1;
  },
};

const ROUND: readonly Measure[] = [
  DAY_OPEN,
  SET_STORED,
  { label: 'Day open, same connection', run: ({ replica }) => dayOpen(replica.read) },
  { label: 'of which dayView', run: ({ replica }) => dayRead(replica.read) },
  { label: 'of which the week', run: ({ replica }) => weekReads(replica.read) },
  { label: `Last time, ${SLOTS} slots`, run: async ({ replica }, round) => (await lastTimesView(replica.read, twelveAt(round), today)).length },
  {
    label: 'Lift chart, 5 years',
    run: async ({ replica }, round) => {
      const lift = liftAt(round);
      const rows = await replica.read.performancesFrom(book.members(lift), addDays(today, -HISTORY_DAYS));
      liftSeries({ lift, rows, book });
      return rows.length;
    },
  },
];

/** Alone, after the rest, so the pages it pulls in cannot warm the reads it is compared with. */
const SCAN: Measure = {
  label: `Table scan, ${SLOTS} slots`,
  run: async ({ replica }, round) => {
    const rows = await replica.read.all('performance');
    for (const lift of twelveAt(round)) lastTimeOf({ lift, rows, book, before: today });
    return rows.length;
  },
};

interface Row {
  readonly label: string;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly runs: number;
  readonly docs: number;
  readonly gateMs: number | undefined;
}

interface Report {
  readonly userAgent: string;
  readonly seedMs: number;
  readonly seeded: number;
  readonly programKb: number;
  readonly rows: readonly Row[];
  /** The page went to the background during the run, so its numbers may include the wait. */
  readonly interrupted: boolean;
  readonly deleted: boolean;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'seeding'; readonly done: number; readonly total: number }
  | { readonly kind: 'measuring'; readonly done: number; readonly total: number }
  | { readonly kind: 'done'; readonly report: Report }
  | { readonly kind: 'failed'; readonly message: string };

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function rowOf(measure: Measure, samples: readonly number[], docs: number): Row {
  const sorted = samples.toSorted((a, b) => a - b);
  return { label: measure.label, medianMs: median(sorted), minMs: sorted[0] ?? 0, maxMs: sorted.at(-1) ?? 0, runs: samples.length, docs, gateMs: measure.gateMs };
}

async function seed(opened: Opened, seeds: readonly Seed[], show: (phase: Phase) => void): Promise<number> {
  const started = performance.now();
  for (let at = 0; at < seeds.length; at += PULL_PAGE) {
    const page = seeds.slice(at, at + PULL_PAGE);
    await opened.port.apply({
      epoch: 'bench',
      lastMutationId: 0,
      rejected: [],
      changes: page.map((record, i) => ({ ...record, rev: at + i + 1 })),
      cursor: Rev.parse(at + page.length),
      more: false,
    });
    show({ kind: 'seeding', done: at + page.length, total: seeds.length });
    await breathe();
  }
  return performance.now() - started;
}

/** A document a schema refused is skipped by apply, not thrown, so count what really landed. */
async function checkSeeded({ replica }: Opened): Promise<void> {
  const expected: readonly (readonly [Kind, number])[] = [
    ['program', 1],
    ['session', SESSIONS],
    ['performance', SESSIONS * PER_SESSION],
    ['entry', ENTRIES_TODAY],
    ['weighIn', HISTORY_DAYS],
    ['goal', 1],
    ['profile', 1],
  ];
  for (const [kind, count] of expected) {
    const held = (await replica.read.all(kind)).length;
    if (held !== count) throw new Error(`seeded ${held} of ${count} ${kind}`);
  }
}

/** The seek must give the answer a scan gives, on this device's IndexedDB, or its speed means nothing. */
async function checkSeekMatchesScan({ replica }: Opened): Promise<void> {
  const rows = await replica.read.all('performance');
  for (const lift of liftIds) {
    const seeked = await lastTimesView(replica.read, [lift], today);
    const read = { lift, book, before: today };
    const fromSeek = lastTimeOf({ ...read, rows: seeked })?.id;
    const fromScan = lastTimeOf({ ...read, rows })?.id;
    if (fromSeek === undefined || fromSeek !== fromScan) throw new Error(`${lift}: seek found ${fromSeek}, scan found ${fromScan}`);
  }
}

async function benchmark(show: (phase: Phase) => void): Promise<Report> {
  let interrupted = false;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') interrupted = true;
  };
  document.addEventListener('visibilitychange', onVisibility);
  const lock = await navigator.wakeLock?.request('screen').catch(() => undefined);

  await deleteBenchDatabase();
  let opened = await openBench();
  try {
    const program = programSeed();
    const seeds = [program, ...diarySeeds(), ...trainingSeeds()];
    const seedMs = await seed(opened, seeds, show);
    await checkSeeded(opened);

    const groups: readonly (readonly Measure[])[] = [ROUND, [SCAN]];
    const total = RUNS * (ROUND.length + 1);
    const samples = new Map<Measure, number[]>();
    const touched = new Map<Measure, number>();
    let done = 0;
    for (const group of groups) {
      for (let round = 0; round < RUNS; round++) {
        for (const measure of group) {
          if (measure.fresh === true) {
            opened.replica.close();
            opened = await openBench();
          }
          const started = performance.now();
          const docs = await measure.run(opened, round);
          const elapsed = performance.now() - started;
          if (docs === 0) throw new Error(`${measure.label} touched no documents`);
          samples.set(measure, [...(samples.get(measure) ?? []), elapsed]);
          touched.set(measure, docs);
          show({ kind: 'measuring', done: ++done, total });
          await breathe();
        }
      }
    }

    await checkSeekMatchesScan(opened);
    const stored = await opened.port.pendingCount();
    if (stored !== RUNS) throw new Error(`${stored} of ${RUNS} sets reached the outbox`);

    const rows = groups.flat().map((measure) => rowOf(measure, samples.get(measure) ?? [], touched.get(measure) ?? 0));
    return { userAgent: navigator.userAgent, seedMs, seeded: seeds.length, programKb: JSON.stringify(program.doc).length / 1024, rows, interrupted, deleted: false };
  } finally {
    opened.replica.close();
    await deleteBenchDatabase();
    document.removeEventListener('visibilitychange', onVisibility);
    await lock?.release();
  }
}

async function benchIsGone(): Promise<boolean> {
  return !(await indexedDB.databases()).some((db) => db.name === DB_NAME);
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

function RowView({ row }: { readonly row: Row }) {
  const passed = row.gateMs === undefined ? null : row.medianMs < row.gateMs;
  return (
    <div class={passed === null ? 'row' : 'row gate'} data-testid="bench-row">
      <div>{row.label}</div>
      <b class={passed === null ? undefined : passed ? 'pass' : 'fail'}>
        {ms(row.medianMs)}
        {passed === null ? '' : passed ? ' PASS' : ' FAIL'}
      </b>
      <div class="small">
        median of {row.runs} runs, range {row.minMs.toFixed(1)} to {row.maxMs.toFixed(1)}, {row.docs} {row.docs === 1 ? 'doc' : 'docs'}
        {row.gateMs === undefined ? '' : `, gate under ${row.gateMs} ms`}
      </div>
    </div>
  );
}

function Bench() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const start = () => {
    setPhase({ kind: 'seeding', done: 0, total: 1 });
    benchmark(setPhase)
      .then(async (report) => setPhase({ kind: 'done', report: { ...report, deleted: await benchIsGone() } }))
      .catch((err: unknown) => setPhase({ kind: 'failed', message: String(err) }));
  };

  switch (phase.kind) {
    case 'idle':
      return (
        <main>
          <h1>fuel bench</h1>
          <p>Times the training reads over 10,000 invented performances in a throwaway database, then deletes it. Your data and the server are not touched. Keep the screen on.</p>
          <button onClick={start}>Start</button>
        </main>
      );
    case 'seeding':
    case 'measuring':
      return (
        <div role="status">
          <h1>{phase.kind === 'seeding' ? 'Seeding' : 'Measuring'}</h1>
          <p>
            {phase.done.toLocaleString()} of {phase.total.toLocaleString()}
          </p>
          <progress value={phase.done} max={phase.total} />
        </div>
      );
    case 'done': {
      const { report } = phase;
      return (
        <main data-testid="bench-report">
          <h1>fuel bench</h1>
          {report.interrupted && <p class="fail">The page went to the background during the run, so rerun this.</p>}
          {report.rows.map((row) => (
            <RowView key={row.label} row={row} />
          ))}
          <div class="row small">
            <p>Seeded {report.seeded.toLocaleString()} documents in {(report.seedMs / 1000).toFixed(1)} s. Program {report.programKb.toFixed(0)} KB.</p>
            <p>{report.deleted ? 'fuel-bench deleted.' : 'fuel-bench is still here.'}</p>
            <p>{report.userAgent}</p>
          </div>
        </main>
      );
    }
    case 'failed':
      return (
        <div role="alert">
          <h1 class="fail">Bench failed</h1>
          <p>{phase.message}</p>
        </div>
      );
  }
}

const root = document.getElementById('bench');
if (root === null) throw new Error('#bench is missing from bench.html');
render(<Bench />, root);
