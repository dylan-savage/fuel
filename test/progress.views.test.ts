/**
 * The Progress sheet's reads over a real replica, so every date bound and index is the shipped
 * one. Each corruption the charts must survive has its test here. All data is invented.
 */
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReplica, type Replica } from '../src/client/replica.js';
import { boardView, liftChartView, loggedLiftsView, showUpView, type LiftChartView } from '../src/client/views.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Lift, Performance } from '../src/domain/lifts.js';
import { epley, lbOf, lineOf, setsLine } from '../src/domain/progress.js';
import type { Program } from '../src/domain/program.js';
import type { Session } from '../src/domain/session.js';
import { band, bw, day, dayKey, kg, lb, lift, liftsBlock, minutes, performance, program, session, slot, target, warm } from './training.fixtures.js';

const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function replicaWith(docs: { readonly programs?: readonly Program[]; readonly sessions?: readonly Session[]; readonly performances?: readonly Performance[] }) {
  const { replica } = await openReplica({ name: 'progress-views', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  await replica.commit([
    ...(docs.programs ?? []).map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
    ...(docs.sessions ?? []).map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...(docs.performances ?? []).map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
  ]);
  return replica;
}

const TODAY = day('2030-06-05');
const SQUAT = lift('squat');
const catalog: readonly Lift[] = [
  { id: SQUAT, name: 'Back squat', aliases: [lift('barbell-squat')], key: true },
  { id: lift('dip'), name: 'Dip', aliases: [], key: true },
  { id: lift('calf-raise'), name: 'Calf raise', aliases: [] },
];
const week = [
  { key: 'a', weekday: 1, blocks: [liftsBlock('main', [slot('a1', 'squat', 3)])] },
  { key: 'b', weekday: 3, blocks: [liftsBlock('main', [slot('b1', 'dip', 3)])] },
];
const version = program('2030-01-07', week, { lifts: [...catalog], weeklyMinimum: 2 });

async function chartOf(performances: readonly Performance[], name = SQUAT): Promise<LiftChartView> {
  const replica = await replicaWith({ programs: [version], performances });
  return liftChartView(replica.read, name, TODAY);
}

describe('warm-ups', () => {
  const clean = [performance({ lift: 'squat', date: '2030-06-01', sets: [lb(100, 5), lb(100, 5)], target: target(3, 8, 12) })];

  it('flagged, never count, however heavy, in the chart, the rows or the bars', async () => {
    const flagged = [performance({ lift: 'squat', date: '2030-06-01', sets: [warm(lb(400, 20)), lb(100, 5), lb(100, 5)], target: target(3, 8, 12) })];
    const [plain, warmed] = await Promise.all([chartOf(clean), chartOf(flagged)]);
    expect(warmed.ranges.all.points[0]?.totals).toEqual(plain.ranges.all.points[0]?.totals);
    expect(warmed.latest?.sets).toHaveLength(2);
    expect(warmed.recent[0]).toMatchObject({ load: '100 lb', reps: '5, 5' });
    expect(warmed.toGo).toEqual(plain.toGo);
  });

  it('unflagged, within the documented limit of 60% and 20 reps, cannot move top weight or est. 1RM', async () => {
    const unflagged = [performance({ lift: 'squat', date: '2030-06-01', sets: [lb(60, 20), lb(100, 5), lb(100, 5)], target: target(3, 8, 12) })];
    const [plain, warmed] = await Promise.all([chartOf(clean), chartOf(unflagged)]);
    expect(warmed.ranges.all.points[0]?.totals.topLb).toBe(plain.ranges.all.points[0]?.totals.topLb);
    expect(warmed.ranges.all.points[0]?.totals.e1rmLb).toBe(plain.ranges.all.points[0]?.totals.e1rmLb);
  });
});

describe('bodyweight and bands', () => {
  it('are null and never 0, and the line bridges them', async () => {
    const view = await chartOf([
      performance({ lift: 'squat', date: '2030-05-01', sets: [lb(100, 5)] }),
      performance({ lift: 'squat', date: '2030-05-08', sets: [bw(20)] }),
      performance({ lift: 'squat', date: '2030-05-15', sets: [band('green', 20)] }),
      performance({ lift: 'squat', date: '2030-05-22', sets: [lb(110, 5)] }),
    ]);
    const series = view.ranges['3m'];
    expect(series.points.map((p) => p.totals.e1rmLb === null)).toEqual([false, true, true, false]);
    expect(series.points.map((p) => p.totals.topLb)).toEqual([100, null, null, 110]);
    expect(lineOf(series).map((p) => p.date)).toEqual(['2030-05-01', '2030-05-22']);
    expect(series.best?.value).toBeCloseTo(epley(110, 5));
    expect(view.recent.map((r) => r.load)).toEqual(['110 lb', 'green', 'BW', '100 lb']);
  });

  it('plots best reps for a lift with no weighted sets, and shows no bars', async () => {
    const view = await chartOf([performance({ lift: 'dip', date: '2030-05-01', sets: [bw(8), bw(10)], target: target(3, 8, 12, { load: 'bodyweight' }) })], lift('dip'));
    expect(view.latestMode).toBe('reps');
    expect(lineOf(view.ranges.all)).toEqual([{ date: day('2030-05-01'), value: 10 }]);
    expect(view.toGo).toBeNull();
    expect(view.recent).toHaveLength(1);
  });
});

describe('kg and lb in one lift', () => {
  it('put every plotted number in lb and leave the sets as typed', async () => {
    const view = await chartOf([performance({ lift: 'squat', date: '2030-05-01', sets: [kg(50, 5)] }), performance({ lift: 'squat', date: '2030-05-08', sets: [lb(120, 5)] })]);
    const [kilos, pounds] = view.ranges['3m'].points;
    const typed = kilos?.sets[0];
    expect(kilos?.totals.topLb).toBeCloseTo(typed === undefined ? 0 : (lbOf(typed.load) ?? 0));
    expect(kilos?.totals.topLb).toBeCloseTo(110.23, 1);
    expect(pounds?.totals.topLb).toBe(120);
    expect(setsLine(kilos?.sets ?? [])).toBe('50 kg × 5');
    expect(setsLine(pounds?.sets ?? [])).toBe('120 × 5');
    expect(view.recent.map((r) => [r.load, r.added])).toEqual([
      ['120 lb', { amount: 9.8, unit: 'lb' }],
      ['50 kg', null],
    ]);
  });
});

describe('a swap', () => {
  const rows = [
    performance({ lift: 'squat', date: '2030-05-01', sets: [lb(200, 5)] }),
    performance({ lift: 'leg-press', planned: 'squat', label: 'Leg press', date: '2030-05-08', sets: [lb(50, 20)] }),
    performance({ lift: 'squat', date: '2030-05-15', sets: [lb(205, 5)] }),
  ];

  it('leaves a gap and a tick on the planned lift, not a dip', async () => {
    const series = (await chartOf(rows)).ranges['3m'];
    expect(series.points.map((p) => p.date)).toEqual(['2030-05-01', '2030-05-15']);
    expect(series.swaps).toEqual([{ date: '2030-05-08', to: 'Leg press' }]);
    expect(Math.min(...lineOf(series).map((p) => p.value))).toBeCloseTo(epley(200, 5));
  });

  it('lands its sets on the lift really done, with no tick there', async () => {
    const series = (await chartOf(rows, lift('leg-press'))).ranges['3m'];
    expect(series.points.map((p) => [p.date, p.totals.topLb])).toEqual([['2030-05-08', 50]]);
    expect(series.swaps).toEqual([]);
  });
});

describe('aliases', () => {
  const rows = [performance({ lift: 'barbell-squat', date: '2030-05-01', sets: [lb(180, 5)] }), performance({ lift: 'squat', date: '2030-05-08', sets: [lb(190, 5)] })];

  it('union into one line through the catalog, from either name', async () => {
    expect((await chartOf(rows)).ranges['3m'].points.map((p) => p.totals.topLb)).toEqual([180, 190]);
    expect((await chartOf(rows, lift('barbell-squat'))).ranges['3m'].points.map((p) => p.totals.topLb)).toEqual([180, 190]);
  });

  it('union on the board and in the list of every lift', async () => {
    const replica = await replicaWith({ programs: [version], performances: rows });
    expect((await boardView(replica.read, TODAY))[0]?.spark).toEqual([epley(180, 5), epley(190, 5)]);
    expect(await loggedLiftsView(replica.read, TODAY)).toEqual([{ liftId: SQUAT, name: 'Back squat', lastDate: '2030-05-08' }]);
  });

  it('count a swap away from an alias as a swap, and a swap to a member as none', async () => {
    const away = [performance({ lift: 'leg-press', planned: 'barbell-squat', label: 'Leg press', date: '2030-05-08', sets: [lb(50, 20)] })];
    expect((await chartOf(away)).ranges['3m'].swaps.map((s) => s.date)).toEqual(['2030-05-08']);
    const within = [performance({ lift: 'barbell-squat', planned: 'squat', date: '2030-05-08', sets: [lb(100, 5)] })];
    const series = (await chartOf(within)).ranges['3m'];
    expect(series.swaps).toEqual([]);
    expect(series.points).toHaveLength(1);
  });
});

describe('few sessions', () => {
  it('reads one session as one value, so a screen can say so instead of drawing a line', async () => {
    const view = await chartOf([performance({ lift: 'squat', date: '2030-05-01', sets: [lb(100, 5)] })]);
    expect(lineOf(view.ranges['3m'])).toHaveLength(1);
    expect(view.latest?.date).toBe('2030-05-01');
  });

  it('reads no sessions as nothing at all, and a range with none apart from the lift', async () => {
    const none = await chartOf([]);
    expect(none).toMatchObject({ latest: null, toGo: null, recent: [] });
    expect(lineOf(none.ranges.all)).toEqual([]);
    const old = await chartOf([performance({ lift: 'squat', date: '2028-05-01', sets: [lb(100, 5)], target: target(3, 3, 5) })]);
    expect(lineOf(old.ranges['3m'])).toEqual([]);
    expect(old.latest?.date).toBe('2028-05-01');
    expect(old.recent).toHaveLength(1);
    expect(old.toGo).not.toBeNull();
  });
});

describe('liftChartView', () => {
  it('leaves out a session dated after today', async () => {
    const view = await chartOf([performance({ lift: 'squat', date: '2030-06-05', sets: [lb(100, 5)] }), performance({ lift: 'squat', date: '2030-06-06', sets: [lb(500, 5)] })]);
    expect(view.ranges.all.points.map((p) => p.date)).toEqual(['2030-06-05']);
  });

  it('keeps a key lift readable with no version in effect', async () => {
    const replica = await replicaWith({ performances: [performance({ lift: 'squat', date: '2030-05-01', sets: [lb(100, 5)] })] });
    expect((await liftChartView(replica.read, SQUAT, TODAY)).ranges.all.points).toHaveLength(1);
  });
});

describe('showUpView', () => {
  const done = (date: string) => session({ date: day(date), finishedAt: minutes(60) });
  const pushDay = { key: dayKey('a'), label: 'A' };

  it('counts this week against the plan, and leaves the week unfinished under its minimum', async () => {
    const replica = await replicaWith({ programs: [version], sessions: [done('2030-06-03'), done('2030-05-20'), done('2030-05-21'), done('2030-03-11')] });
    const view = await showUpView(replica.read, TODAY);
    expect(view).toMatchObject({ done: 1, planned: 2, minimum: 2, unfinished: true });
    expect(view.weeks).toHaveLength(12);
    expect(view.weeks[0]).toMatchObject({ monday: '2030-03-18', done: 0 });
    expect(view.weeks.reduce((sum, w) => sum + w.done, 0)).toBe(3);
  });

  it('finishes the week at its minimum, counts an import and a cardio-only day, and not an empty session', async () => {
    const cardio = session({ date: day('2030-06-03'), day: { key: dayKey('swim'), label: 'Swim' }, source: 'notion', startedAt: undefined });
    const imported = session({ date: day('2030-06-04'), day: pushDay, source: 'notion', startedAt: undefined });
    const empty = session({ date: day('2030-06-05'), day: pushDay });
    const replica = await replicaWith({ programs: [version], sessions: [cardio, imported, empty] });
    expect(await showUpView(replica.read, TODAY)).toMatchObject({ done: 2, unfinished: false });
  });

  it('counts a session in progress by its working set, not its warm-up', async () => {
    const working = session({ date: day('2030-06-03'), day: pushDay });
    const warming = session({ date: day('2030-06-04'), day: pushDay });
    const replica = await replicaWith({
      programs: [version],
      sessions: [working, warming],
      performances: [performance({ session: working.id, lift: 'squat', date: '2030-06-03', sets: [lb(100, 5)] }), performance({ session: warming.id, lift: 'dip', date: '2030-06-04', sets: [warm(bw(5))] })],
    });
    expect((await showUpView(replica.read, TODAY)).done).toBe(1);
  });

  it('answers before any program exists', async () => {
    const replica = await replicaWith({});
    expect(await showUpView(replica.read, TODAY)).toMatchObject({ done: 0, planned: 0, minimum: null, unfinished: false });
  });
});

describe('boardView', () => {
  const lifts: readonly Lift[] = ['squat', 'dip', 'row', 'curl'].map((id) => ({ id: lift(id), name: id, aliases: [], key: true }));
  const others: readonly Lift[] = ['fly', 'press', 'lunge'].map((id) => ({ id: lift(id), name: id, aliases: [] }));
  const boardOf = async (done: readonly (readonly [string, string])[]) => {
    const replica = await replicaWith({
      programs: [program('2030-04-01', [{ key: 'a', blocks: [liftsBlock('main', [slot('a1', 'squat', 3)])] }], { lifts: [...lifts, ...others] })],
      performances: done.map(([id, date]) => performance({ lift: id, date, sets: [lb(100, 5)] })),
    });
    return (await boardView(replica.read, TODAY)).map((row) => row.name);
  };

  it('holds only the key lifts done in twelve weeks, in catalog order, when that is enough', async () => {
    const recent = '2030-05-01';
    expect(await boardOf([['row', recent], ['squat', recent], ['curl', recent], ['fly', recent], ['dip', '2029-01-01']])).toEqual(['squat', 'row', 'curl']);
  });

  it('tops the board up to three from the lifts logged most recently', async () => {
    expect(await boardOf([['squat', '2030-05-01'], ['fly', '2030-04-20'], ['press', '2030-05-02'], ['lunge', '2030-04-10']])).toEqual(['squat', 'press', 'fly']);
  });

  it('fills with nothing older than the window, so it can hold fewer than three', async () => {
    expect(await boardOf([['squat', '2030-05-01'], ['fly', '2029-01-01']])).toEqual(['squat']);
  });

  it('has no rows with no version in effect', async () => {
    expect(await boardView((await replicaWith({})).read, TODAY)).toEqual([]);
  });
});

describe('loggedLiftsView', () => {
  it('finds every lift once, newest first, a name the catalog has not placed included', async () => {
    const replica = await replicaWith({
      programs: [version],
      performances: [
        performance({ lift: 'squat', date: '2030-01-01', sets: [lb(100, 5)] }),
        performance({ lift: 'squat', date: '2030-02-01', sets: [lb(100, 5)] }),
        performance({ lift: 'calf-raise', date: '2030-03-01', sets: [lb(100, 5)] }),
        performance({ lift: 'sled-push', label: 'Sled push', date: '2028-01-01', sets: [lb(100, 5)] }),
        performance({ lift: 'leg-press', planned: 'dip', label: 'Leg press', date: '2030-04-01', sets: [lb(100, 5)] }),
      ],
    });
    expect((await loggedLiftsView(replica.read, TODAY)).map((l) => [l.name, l.lastDate])).toEqual([
      ['Leg press', '2030-04-01'],
      ['Calf raise', '2030-03-01'],
      ['Back squat', '2030-02-01'],
      ['Sled push', '2028-01-01'],
    ]);
  });

  it('is empty with nothing logged', async () => {
    expect(await loggedLiftsView((await replicaWith({})).read, TODAY)).toEqual([]);
  });

  it('re-runs as a live query when a new lift is logged', async () => {
    // A live query only runs where Dexie found a global indexedDB, which Node has none of.
    Object.assign(Dexie.dependencies, { indexedDB: new IDBFactory(), IDBKeyRange });
    const replica = await replicaWith({ programs: [version], performances: [performance({ lift: 'squat', date: '2030-01-01', sets: [lb(100, 5)] })] });
    const seen: (readonly string[])[] = [];
    const stop = replica.live((r) => loggedLiftsView(r, TODAY)).subscribe((lifts) => seen.push(lifts.map((l) => l.name)));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Back squat']));
    await replica.commit([{ op: 'put', kind: 'performance', doc: performance({ lift: 'sled-push', label: 'Sled push', date: '2030-02-01', sets: [lb(100, 5)] }) }]);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Sled push', 'Back squat']));
    stop();
  });
});
