import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KG_PER_LB } from '../src/domain/goals.js';
import { liftBook, type Performance } from '../src/domain/lifts.js';
import { plannedDay, type PlannedDay } from '../src/domain/program.js';
import {
  SHOW_UP_WEEKS,
  addWeightNext,
  boardRow,
  epley,
  lastLineOf,
  lastSwapAt,
  lastTimeOf,
  lbOf,
  liftSeries,
  recentSessions,
  repsToGo,
  sessionsDone,
  showUp,
  skipsOf,
  swapsOf,
  totalsOf,
  typedLine,
  weekProgress,
  type LiftRead,
} from '../src/domain/progress.js';
import type { Session } from '../src/domain/session.js';
import { band, bw, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, performance, program, session, sides, slot, slotId, target, warm } from './training.fixtures.js';

const noCatalog = liftBook([]);
const read = (name: string, rows: readonly Performance[]): LiftRead => ({ lift: lift(name), rows, book: noCatalog });

describe('lbOf', () => {
  it('passes pounds through and converts kilograms', () => {
    expect(lbOf({ kind: 'weight', amount: 135, unit: 'lb' })).toBe(135);
    expect(lbOf({ kind: 'weight', amount: 20, unit: 'kg' })).toBeCloseTo(44.0925, 3);
  });

  it('gives null for bodyweight and bands, never 0', () => {
    expect(lbOf({ kind: 'bodyweight' })).toBeNull();
    expect(lbOf({ kind: 'band', label: 'green' })).toBeNull();
  });
});

describe('epley', () => {
  it('is weight times one plus reps over thirty', () => {
    expect(epley(100, 3)).toBeCloseTo(110);
    expect(epley(90, 10)).toBeCloseTo(120);
  });
});

describe('totalsOf', () => {
  it('works by hand on plain pounds: 100x10, 100x8, 90x8', () => {
    expect(totalsOf([lb(100, 10), lb(100, 8), lb(90, 8)])).toEqual({
      topLb: 100,
      volumeLb: 1000 + 800 + 720,
      e1rmLb: 100 * (1 + 10 / 30),
    });
  });

  it('puts kg and lb on one axis in one lift', () => {
    const totals = totalsOf([kg(50, 5), lb(100, 5)]);
    const fiftyKg = 50 / KG_PER_LB;
    expect(fiftyKg).toBeCloseTo(110.231, 3);
    expect(totals.topLb).toBeCloseTo(fiftyKg);
    expect(totals.volumeLb).toBeCloseTo(fiftyKg * 5 + 500);
    expect(totals.e1rmLb).toBeCloseTo(fiftyKg * (1 + 5 / 30));
  });

  it('gives null, not 0, for a bodyweight-only lift and for a band', () => {
    const nothing = { topLb: null, volumeLb: null, e1rmLb: null };
    expect(totalsOf([bw(12), bw(10)])).toEqual(nothing);
    expect(totalsOf([band('green', 15)])).toEqual(nothing);
  });

  it('ignores bodyweight sets beside weighted ones', () => {
    expect(totalsOf([bw(12), lb(25, 6)])).toEqual({ topLb: 25, volumeLb: 150, e1rmLb: 25 * 1.2 });
  });

  it('reads a per-side set by its better side for est. 1RM and counts both sides of volume', () => {
    expect(totalsOf([sides(30, 12, 9)])).toEqual({ topLb: 30, volumeLb: 30 * 21, e1rmLb: 30 * 1.4 });
  });

  it('leaves out flagged warm-ups entirely', () => {
    expect(totalsOf([warm(lb(200, 20)), lb(100, 5)])).toEqual({ topLb: 100, volumeLb: 500, e1rmLb: 100 * (1 + 5 / 30) });
    expect(totalsOf([warm(lb(100, 5))])).toEqual({ topLb: null, volumeLb: null, e1rmLb: null });
  });

  it('does not let a set of no reps move a maximum', () => {
    expect(totalsOf([lb(100, 0), lb(90, 5)])).toEqual({ topLb: 90, volumeLb: 450, e1rmLb: 90 * (1 + 5 / 30) });
  });

  it('lets a long light set outscore a short heavy one, because est. 1RM is a maximum over working sets', () => {
    expect(totalsOf([lb(100, 3), lb(80, 15)]).e1rmLb).toBeCloseTo(120);
    expect(totalsOf([lb(100, 3), lb(80, 15)]).topLb).toBe(100);
  });

  it('cannot be moved by an unflagged warm-up at up to 60% of the load, up to 20 reps', () => {
    const topSet = fc.record({ amount: fc.integer({ min: 20, max: 600 }), reps: fc.integer({ min: 1, max: 20 }) });
    const lighter = fc.record({ share: fc.double({ min: 0.05, max: 0.6, noNaN: true }), reps: fc.integer({ min: 1, max: 20 }) });
    fc.assert(
      fc.property(topSet, fc.array(lighter, { maxLength: 4 }), fc.boolean(), (top, warmups, warmupsFirst) => {
        const light = warmups.map((w) => lb(top.amount * w.share, w.reps));
        const heavy = lb(top.amount, top.reps);
        const before = totalsOf([heavy]);
        const after = totalsOf(warmupsFirst ? [...light, heavy] : [heavy, ...light]);
        expect(after.topLb).toBe(before.topLb);
        expect(after.e1rmLb).toBe(before.e1rmLb);
      }),
    );
  });
});

describe('typedLine', () => {
  it.each([
    ['one load', [lb(50, 10), lb(50, 9), lb(50, 8)], '50 lb x 10/9/8'],
    ['a ramp in one unit', [lb(30, 11), lb(45, 10), lb(50, 9)], '30/45/50 lb x 11/10/9'],
    ['kg stays kg', [kg(8, 14)], '8 kg x 14'],
    ['mixed units', [kg(8, 12), lb(20, 10)], '8 kg/20 lb x 12/10'],
    ['bodyweight', [bw(11), bw(9)], 'BW x 11/9'],
    ['a band', [band('green', 12)], 'green x 12'],
    ['per side', [sides(25, 10, 9)], '25 lb x 10+9'],
    ['a load with a bodyweight set', [lb(25, 5), bw(8)], '25 lb/BW x 5/8'],
  ])('writes %s', (_name, sets, line) => {
    expect(typedLine(sets)).toBe(line);
  });
});

describe('repsToGo', () => {
  const threeByTen = target(3, 8, 10);
  const at = (sets: Performance['sets'], t = threeByTen) => repsToGo(performance({ lift: 'bench-press', target: t, sets }));

  it('counts a prescribed set not done as missing all its reps', () => {
    expect(at([lb(100, 10), lb(100, 9)])).toEqual({
      topLb: 100,
      load: { kind: 'weight', amount: 100, unit: 'lb' },
      top: 10,
      sets: [
        { reps: 10, missing: 0 },
        { reps: 9, missing: 1 },
        { reps: null, missing: 10 },
      ],
      missing: 11,
      ready: false,
    });
  });

  it('counts a set past the top as zero missing, never negative', () => {
    const go = at([lb(100, 14), lb(100, 8), lb(100, 10)]);
    expect(go?.sets.map((s) => s.missing)).toEqual([0, 2, 0]);
    expect(go?.missing).toBe(2);
  });

  it('is ready only when every prescribed set reached the top', () => {
    expect(at([lb(100, 10), lb(100, 10), lb(100, 12)])?.ready).toBe(true);
    expect(at([lb(100, 10), lb(100, 10), lb(100, 9)])?.ready).toBe(false);
    expect(at([lb(100, 10), lb(100, 10)])?.ready).toBe(false);
  });

  it('reads only working sets at the top load, so a lighter set is not a done set', () => {
    const go = at([warm(lb(45, 10)), lb(90, 12), lb(100, 10), lb(100, 10)]);
    expect(go?.topLb).toBe(100);
    expect(go?.sets).toEqual([
      { reps: 10, missing: 0 },
      { reps: 10, missing: 0 },
      { reps: null, missing: 10 },
    ]);
    expect(go?.missing).toBe(10);
  });

  it('does not let a warm-up heavier than the work set the top load', () => {
    expect(at([warm(lb(200, 10)), lb(100, 10), lb(100, 10), lb(100, 10)])?.ready).toBe(true);
  });

  it('counts the best of an extra set, so a low extra does not unready the rest', () => {
    const go = at([lb(100, 10), lb(100, 10), lb(100, 6), lb(100, 10)]);
    expect(go?.sets).toHaveLength(4);
    expect(go?.missing).toBe(0);
    expect(go?.ready).toBe(true);
  });

  it('compares kg and lb sets on one scale and keeps the top load as typed', () => {
    const go = at([kg(50, 10), lb(100, 12)], target(2, 8, 10));
    expect(go?.load).toEqual({ kind: 'weight', amount: 50, unit: 'kg' });
    expect(go?.sets).toEqual([
      { reps: 10, missing: 0 },
      { reps: null, missing: 10 },
    ]);
  });

  it('reads a per-side set by its weaker side, so both sides have to reach the top', () => {
    expect(at([sides(30, 10, 8), sides(30, 10, 10), sides(30, 11, 10)])?.ready).toBe(false);
    expect(at([sides(30, 10, 8), sides(30, 10, 10), sides(30, 11, 10)])?.missing).toBe(2);
    expect(at([sides(30, 10, 10), sides(30, 10, 11), sides(30, 12, 10)])?.ready).toBe(true);
  });

  it('gives null for a bodyweight or band load, and with no range above zero', () => {
    expect(at([bw(12), bw(12), bw(12)])).toBeNull();
    expect(at([band('green', 12)])).toBeNull();
    expect(at([lb(25, 5)], target(3, 8, 10, { load: 'bodyweight' }))).toBeNull();
    expect(at([lb(25, 5)], target(3, 8, 10, { load: 'band' }))).toBeNull();
    expect(at([lb(25, 5)], target(3, 0, 0))).toBeNull();
    expect(repsToGo(performance({ lift: 'bench-press', sets: [lb(25, 5)] }))).toBeNull();
  });

  it('gives null with only warm-ups logged', () => {
    expect(at([warm(lb(45, 10))])).toBeNull();
  });

  it('is never negative and ready exactly when nothing is missing', () => {
    const anySets = fc.array(fc.tuple(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 0, max: 40 })), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(anySets, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 20 }), (raw, sets, top) => {
        const go = at(
          raw.map(([amount, reps]) => lb(amount, reps)),
          target(sets, 1, top),
        );
        if (go === null) return;
        expect(go.missing).toBeGreaterThanOrEqual(0);
        for (const row of go.sets) expect(row.missing).toBeGreaterThanOrEqual(0);
        expect(go.ready).toBe(go.missing === 0);
      }),
    );
  });
});

describe('addWeightNext', () => {
  it('needs the full prescribed count at the top of the range', () => {
    const t = target(2, 8, 10);
    expect(addWeightNext(performance({ lift: 'bench-press', target: t, sets: [lb(100, 10), lb(100, 10)] }))).toBe(true);
    expect(addWeightNext(performance({ lift: 'bench-press', target: t, sets: [lb(100, 10)] }))).toBe(false);
  });

  it('never fires on a bodyweight lift', () => {
    expect(addWeightNext(performance({ lift: 'pull-up', target: target(1, 5, 8), sets: [bw(20)] }))).toBe(false);
  });
});

describe('last time', () => {
  const before = day('2030-03-18');
  const squat = performance({ lift: 'squat', date: '2030-03-04', sets: [lb(200, 5)] });
  const swapAway = performance({ lift: 'leg-press', planned: 'squat', date: '2030-03-11', label: 'Leg press', sets: [lb(300, 12), lb(300, 10)] });

  it('finds the newest row of this lift before the bound, ignoring today', () => {
    const today = performance({ lift: 'squat', date: '2030-03-18', sets: [lb(205, 5)] });
    expect(lastTimeOf({ ...read('squat', [squat, today, swapAway]), before })).toBe(squat);
  });

  it('counts a set done as a swap for another lift under the lift done', () => {
    expect(lastTimeOf({ ...read('leg-press', [squat, swapAway]), before })).toBe(swapAway);
  });

  it('offers the swap when it is newer than the planned lift', () => {
    expect(lastSwapAt({ ...read('squat', [squat, swapAway]), before })).toEqual({
      date: day('2030-03-11'),
      liftId: lift('leg-press'),
      label: 'Leg press',
      line: '300 lb x 12/10',
    });
  });

  it('stops offering it once he has done the planned lift since', () => {
    const since = performance({ lift: 'squat', date: '2030-03-12', sets: [lb(200, 5)] });
    expect(lastSwapAt({ ...read('squat', [squat, swapAway, since]), before })).toBeUndefined();
  });

  it('ignores a swap on the day of the card', () => {
    expect(lastSwapAt({ ...read('squat', [swapAway]), before: day('2030-03-11') })).toBeUndefined();
  });

  it('reads through an alias, and a merge is not a swap', () => {
    const book = liftBook([{ id: lift('squat'), name: 'Squat', aliases: [lift('back-squat')] }]);
    const old = performance({ lift: 'back-squat', date: '2030-03-01', sets: [lb(180, 5)] });
    const swapToAlias = performance({ lift: 'back-squat', planned: 'squat', date: '2030-03-02', sets: [lb(185, 5)] });
    expect(lastTimeOf({ lift: lift('squat'), rows: [old], book, before })).toBe(old);
    expect(lastSwapAt({ lift: lift('squat'), rows: [swapToAlias], book, before })).toBeUndefined();
  });
});

describe('recentSessions', () => {
  it('marks where the top load rose, newest first, across units and a bodyweight day', () => {
    const rows = [
      performance({ lift: 'pull-up', date: '2030-03-01', sets: [lb(20, 5)] }),
      performance({ lift: 'pull-up', date: '2030-03-02', sets: [lb(20, 6)] }),
      performance({ lift: 'pull-up', date: '2030-03-03', sets: [bw(10)] }),
      performance({ lift: 'pull-up', date: '2030-03-04', sets: [kg(10, 5)] }),
      performance({ lift: 'pull-up', date: '2030-03-05', sets: [lb(20, 5)] }),
    ];
    expect(recentSessions(read('pull-up', rows), 10).map((r) => [r.date, r.line, r.rose])).toEqual([
      ['2030-03-05', '20 lb x 5', false],
      ['2030-03-04', '10 kg x 5', true],
      ['2030-03-03', 'BW x 10', false],
      ['2030-03-02', '20 lb x 6', false],
      ['2030-03-01', '20 lb x 5', false],
    ]);
  });

  it('keeps warm-ups out of the line and honors the limit', () => {
    const rows = [performance({ lift: 'squat', date: '2030-03-01', sets: [lb(100, 5)] }), performance({ lift: 'squat', date: '2030-03-02', sets: [warm(lb(45, 10)), lb(105, 5)] })];
    const recent = recentSessions(read('squat', rows), 1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.line).toBe('105 lb x 5');
    expect(recent[0]?.rose).toBe(true);
  });
});

describe('liftSeries', () => {
  it('rings the best est. 1RM and leaves a swapped day as a tick with no point', () => {
    const rows = [
      performance({ lift: 'squat', date: '2030-03-01', sets: [lb(200, 5)] }),
      performance({ lift: 'squat', date: '2030-03-08', sets: [lb(210, 5)] }),
      performance({ lift: 'leg-press', planned: 'squat', date: '2030-03-15', label: 'Leg press', sets: [lb(400, 12)] }),
      performance({ lift: 'squat', date: '2030-03-22', sets: [lb(205, 5)] }),
    ];
    const series = liftSeries(read('squat', rows));
    expect(series.mode).toBe('load');
    expect(series.points.map((p) => p.date)).toEqual(['2030-03-01', '2030-03-08', '2030-03-22']);
    expect(series.best?.date).toBe('2030-03-08');
    expect(series.best?.value).toBeCloseTo(210 * (1 + 5 / 30));
    expect(series.swaps).toEqual([{ date: day('2030-03-15'), to: 'Leg press' }]);
  });

  it('prefers the newest of a tied best', () => {
    const rows = [performance({ lift: 'squat', date: '2030-03-01', sets: [lb(200, 5)] }), performance({ lift: 'squat', date: '2030-03-08', sets: [lb(200, 5)] })];
    expect(liftSeries(read('squat', rows)).best?.date).toBe('2030-03-08');
  });

  it('plots reps for a lift never loaded', () => {
    const rows = [performance({ lift: 'pull-up', date: '2030-03-01', sets: [bw(8), bw(6)] }), performance({ lift: 'pull-up', date: '2030-03-08', sets: [bw(10)] })];
    const series = liftSeries(read('pull-up', rows));
    expect(series.mode).toBe('reps');
    expect(series.best).toEqual({ date: day('2030-03-08'), value: 10 });
    expect(series.points.every((p) => p.totals.e1rmLb === null)).toBe(true);
  });

  it('leaves a gap on a bodyweight day of a loaded lift, not a zero', () => {
    const rows = [performance({ lift: 'pull-up', date: '2030-03-01', sets: [lb(20, 5)] }), performance({ lift: 'pull-up', date: '2030-03-08', sets: [bw(10)] })];
    const series = liftSeries(read('pull-up', rows));
    expect(series.mode).toBe('load');
    expect(series.points[1]?.totals.e1rmLb).toBeNull();
    expect(series.best?.date).toBe('2030-03-01');
  });

  it('merges two sessions of one date and drops a date of only warm-ups', () => {
    const rows = [
      performance({ lift: 'squat', date: '2030-03-01', sets: [lb(100, 5)] }),
      performance({ lift: 'squat', date: '2030-03-01', sets: [lb(120, 3)] }),
      performance({ lift: 'squat', date: '2030-03-08', sets: [warm(lb(45, 10))] }),
    ];
    const series = liftSeries(read('squat', rows));
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.totals.topLb).toBe(120);
    expect(series.points[0]?.totals.volumeLb).toBe(500 + 360);
  });

  it('unions an alias into one line', () => {
    const book = liftBook([{ id: lift('squat'), name: 'Squat', aliases: [lift('back-squat')] }]);
    const rows = [performance({ lift: 'back-squat', date: '2030-03-01', sets: [lb(180, 5)] }), performance({ lift: 'squat', date: '2030-03-08', sets: [lb(190, 5)] })];
    expect(liftSeries({ lift: lift('squat'), rows, book }).points.map((p) => p.totals.topLb)).toEqual([180, 190]);
  });
});

describe('boardRow', () => {
  const book = liftBook([{ id: lift('squat'), name: 'Back squat', aliases: [], key: true }]);
  const today = day('2030-06-02');

  it('gives latest, change over the window and sessions since best, with older rows left out', () => {
    const rows = [
      // 90 days before today, so outside the 12 weeks.
      performance({ lift: 'squat', date: '2030-03-04', sets: [lb(300, 5)] }),
      performance({ lift: 'squat', date: '2030-04-01', sets: [lb(150, 3)] }),
      performance({ lift: 'squat', date: '2030-05-01', sets: [lb(180, 5)] }),
      performance({ lift: 'squat', date: '2030-05-15', sets: [lb(165, 2)] }),
      performance({ lift: 'squat', date: '2030-06-01', sets: [lb(162, 5)] }),
    ];
    const row = boardRow({ lift: lift('squat'), rows, book, today });
    expect(row.name).toBe('Back squat');
    expect(row.spark).toEqual([150 * 1.1, 180 * (1 + 5 / 30), 165 * (1 + 2 / 30), 162 * (1 + 5 / 30)]);
    expect(row.latest).toBeCloseTo(189);
    expect(row.change).toBeCloseTo(189 - 165);
    expect(row.sessionsSinceBest).toBe(2);
  });

  it('counts the day exactly twelve weeks back as outside the window', () => {
    const rows = [performance({ lift: 'squat', date: '2030-03-10', sets: [lb(100, 5)] }), performance({ lift: 'squat', date: '2030-03-11', sets: [lb(110, 5)] })];
    expect(boardRow({ lift: lift('squat'), rows, book, today }).spark).toEqual([110 * (1 + 5 / 30)]);
  });

  it('has no change with one point and nothing at all with none', () => {
    const one = boardRow({ lift: lift('squat'), rows: [performance({ lift: 'squat', date: '2030-05-01', sets: [lb(100, 3)] })], book, today });
    expect(one.latest).toBeCloseTo(110);
    expect(one.change).toBeNull();
    expect(one.sessionsSinceBest).toBe(0);
    expect(boardRow({ lift: lift('squat'), rows: [], book, today })).toMatchObject({ latest: null, change: null, sessionsSinceBest: null, spark: [] });
  });

  it('reads reps for a bodyweight key lift', () => {
    const rows = [performance({ lift: 'pull-up', date: '2030-05-01', sets: [bw(8)] }), performance({ lift: 'pull-up', date: '2030-05-08', sets: [warm(bw(3)), bw(11)] })];
    expect(boardRow({ lift: lift('pull-up'), rows, book, today })).toMatchObject({ mode: 'reps', spark: [8, 11], latest: 11, change: 3, sessionsSinceBest: 0 });
  });
});

describe('sessionsDone', () => {
  it('counts a working set, a finish or an import, and not an empty or warm-up-only session', () => {
    const worked = session();
    const finished = session({ finishedAt: minutes(30) });
    const imported = session({ source: 'notion' });
    const empty = session();
    const warmedUp = session();
    const performances = [performance({ session: worked.id, lift: 'squat', sets: [lb(100, 5)] }), performance({ session: warmedUp.id, lift: 'squat', sets: [warm(lb(45, 5))] })];
    expect(sessionsDone([worked, finished, imported, empty, warmedUp], performances)).toEqual([worked, finished, imported]);
  });
});

describe('weekProgress', () => {
  const lifting = [liftsBlock('main', [slot('a1', 'bench-press', 3)])];
  const version = program('2030-03-04', [
    { key: 'thu', weekday: 4, blocks: lifting },
    { key: 'mon', weekday: 1, blocks: lifting },
    { key: 'any', blocks: lifting },
    { key: 'wed', weekday: 3, blocks: [checklist('retest', { onlyWeek: day('2030-03-04') })] },
  ]);
  const week = (date: string, sessions: readonly Session[] = [], performances: readonly Performance[] = []) => weekProgress({ program: version, sessions, performances, today: day(date) });
  const on = (key: string, date: string, extra: Partial<Session> = {}) => session({ date: day(date), day: { key: dayKey(key), label: key }, finishedAt: minutes(60), ...extra });

  it('orders days by weekday with undated ones after, and drops a day holding only lapsed blocks', () => {
    expect(week('2030-03-05').days.map((d) => d.plan.key)).toEqual(['mon', 'wed', 'thu', 'any']);
    expect(week('2030-03-12').days.map((d) => d.plan.key)).toEqual(['mon', 'thu', 'any']);
  });

  it('marks a day with the date he trained it, not the planned weekday', () => {
    const shown = week('2030-03-08', [on('thu', '2030-03-07'), on('mon', '2030-03-06')]);
    expect(shown.days.map((d) => [d.plan.key, d.doneOn])).toEqual([
      ['mon', '2030-03-06'],
      ['wed', null],
      ['thu', '2030-03-07'],
      ['any', null],
    ]);
    expect(shown.done).toBe(2);
    expect(shown.strip).toEqual([true, false, true, false]);
  });

  it('suggests today\'s weekday while it is undone, else the first undone day', () => {
    expect(week('2030-03-07').suggested?.key).toBe('thu');
    expect(week('2030-03-07', [on('thu', '2030-03-07')]).suggested?.key).toBe('mon');
    expect(week('2030-03-05').suggested?.key).toBe('mon');
    const everyDay = ['mon', 'wed', 'thu', 'any'].map((key) => on(key, '2030-03-05'));
    expect(week('2030-03-05', everyDay).suggested).toBeNull();
  });

  it('counts an imported session with no pin toward its day', () => {
    const shown = week('2030-03-08', [on('mon', '2030-03-04', { source: 'notion', finishedAt: undefined })]);
    expect(shown.days[0]?.doneOn).toBe('2030-03-04');
    expect(shown.done).toBe(1);
  });

  it('counts a cardio-only import naming no planned day, filling the strip so it agrees with the count', () => {
    const swim = session({ date: day('2030-03-05'), day: { key: dayKey('swim'), label: 'Swim' }, source: 'notion', note: 'Invented swim.' });
    const shown = week('2030-03-08', [swim, on('thu', '2030-03-07')]);
    expect(shown.done).toBe(2);
    expect(shown.days.filter((d) => d.doneOn !== null).map((d) => d.plan.key)).toEqual(['thu']);
    expect(shown.strip).toEqual([true, false, true, false]);
  });

  it('counts a session off plan with no day at all', () => {
    const off = session({ day: undefined, date: day('2030-03-05') });
    const shown = week('2030-03-08', [off], [performance({ session: off.id, date: '2030-03-05', lift: 'squat', sets: [lb(100, 5)] })]);
    expect(shown.done).toBe(1);
    expect(shown.strip).toEqual([true, false, false, false]);
  });

  it('never fills past the plan when he does more than it holds', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => on(key, '2030-03-05'));
    const shown = week('2030-03-12', many);
    expect(shown.done).toBe(6);
    expect(shown.strip).toEqual([true, true, true]);
  });

  it('leaves out a session opened and left empty', () => {
    expect(week('2030-03-05', [on('mon', '2030-03-05', { finishedAt: undefined })]).days[0]?.doneOn).toBeNull();
  });
});

describe('lastLineOf', () => {
  const book = liftBook([{ id: lift('bench-press'), name: 'Bench press', aliases: [lift('flat-bench')] }]);
  const read = (rows: readonly Performance[]) => lastLineOf({ lift: lift('bench-press'), book, rows, before: day('2030-03-11') });

  it('writes the working sets as typed, with the date', () => {
    expect(read([performance({ date: '2030-03-04', lift: 'bench-press', sets: [warm(kg(20, 10)), kg(62.5, 8), kg(62.5, 8), kg(62.5, 6)] })])).toEqual({ date: '2030-03-04', line: '62.5 kg × 8/8/6', addWeight: false });
  });

  it('writes a per-side set as both sides', () => {
    expect(read([performance({ date: '2030-03-04', lift: 'bench-press', sets: [sides(30, 10, 9), sides(30, 9, 8)] })])?.line).toBe('30 lb × 10+9/9+8');
  });

  it('finds a lift logged under its alias', () => {
    expect(read([performance({ date: '2030-03-04', lift: 'flat-bench', sets: [lb(100, 8)] })])?.line).toBe('100 lb × 8');
  });

  it('flags add-weight from the performance\'s own target', () => {
    const top = [lb(100, 10), lb(100, 10)];
    expect(read([performance({ date: '2030-03-04', lift: 'bench-press', sets: top, target: target(2, 8, 10) })])?.addWeight).toBe(true);
    expect(read([performance({ date: '2030-03-04', lift: 'bench-press', sets: top, target: target(3, 8, 10) })])?.addWeight).toBe(false);
  });

  it('is null before the lift was done, and when last time held only warm-ups', () => {
    expect(read([])).toBeNull();
    expect(read([performance({ date: '2030-03-04', lift: 'bench-press', sets: [warm(lb(45, 10))] })])).toBeNull();
  });
});

describe('skipsOf', () => {
  const version = program('2030-03-04', [
    {
      key: 'push',
      blocks: [liftsBlock('main', [slot('a1', 'bench-press', 3), slot('a2', 'cable-row', 2, { label: 'Cable row' })]), liftsBlock('abs', [slot('c1', 'crunch', 2)], { optional: true })],
    },
  ]);
  const plan: PlannedDay | undefined = plannedDay(version, dayKey('push'), day('2030-03-04'));
  const skipIds = (input: Parameters<typeof skipsOf>[0]) => skipsOf(input).map((s) => s.slotId);

  it('calls an untouched required slot of a finished session a skip, tapped or not, and leaves optional blocks out', () => {
    const push = session({ finishedAt: minutes(60) });
    const performances = [performance({ session: push.id, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] })];
    expect(skipsOf({ session: push, performances, plan, phase: 'finished' })).toEqual([{ slotId: slotId('a2'), label: 'Cable row', note: null }]);
  });

  it('calls a slot with only warm-ups a skip', () => {
    const push = session({ finishedAt: minutes(60) });
    const performances = [performance({ session: push.id, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] }), performance({ session: push.id, slot: 'a2', lift: 'cable-row', sets: [warm(lb(40, 10))] })];
    expect(skipIds({ session: push, performances, plan, phase: 'finished' })).toEqual(['a2']);
  });

  it('does not count a set from a swap as a skip of the slot', () => {
    const push = session({ finishedAt: minutes(60) });
    const performances = [performance({ session: push.id, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] }), performance({ session: push.id, slot: 'a2', lift: 'dumbbell-row', planned: 'cable-row', sets: [lb(50, 10)] })];
    expect(skipIds({ session: push, performances, plan, phase: 'finished' })).toEqual([]);
  });

  it('counts only tapped skips while the session is open, with the tapped note', () => {
    const open = session({ skips: [{ slotId: slotId('a2'), note: 'Machine taken' }] });
    const performances = [performance({ session: open.id, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] })];
    expect(skipsOf({ session: open, performances, plan, phase: 'open' })).toEqual([{ slotId: slotId('a2'), label: 'Cable row', note: 'Machine taken' }]);
    expect(skipIds({ session: session(), performances: [], plan, phase: 'open' })).toEqual([]);
  });

  it('has no skips for a day never started, even after it lapses', () => {
    expect(skipIds({ session: session(), performances: [], plan, phase: 'lapsed' })).toEqual([]);
  });

  it('keeps a tapped skip when the plan is unknown', () => {
    const imported = session({ source: 'notion', skips: [{ slotId: slotId('old-slot') }] });
    expect(skipsOf({ session: imported, performances: [], plan: undefined, phase: 'imported' })).toEqual([{ slotId: slotId('old-slot'), label: 'old-slot', note: null }]);
  });

  it('ignores sets from other sessions', () => {
    const push = session({ finishedAt: minutes(60) });
    const elsewhere = performance({ slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] });
    expect(skipIds({ session: push, performances: [elsewhere], plan, phase: 'finished' })).toEqual(['a1', 'a2']);
  });
});

describe('swapsOf', () => {
  it('lists the rows that were swapped, and only those', () => {
    const rows = [performance({ lift: 'squat', sets: [lb(100, 5)] }), performance({ lift: 'leg-press', planned: 'squat', label: 'Leg press', sets: [lb(200, 10)] })];
    expect(swapsOf(rows)).toEqual([{ date: day('2030-03-04'), plannedLiftId: lift('squat'), liftId: lift('leg-press'), label: 'Leg press' }]);
  });
});

describe('showUp', () => {
  const today = day('2030-03-13');
  const done = (date: string) => session({ date: day(date), finishedAt: minutes(60) });

  it('gives twelve weeks ending this week against the minimum', () => {
    const sessions = [done('2030-03-11'), done('2030-03-13'), done('2029-12-24'), done('2029-12-23'), session({ date: day('2030-03-12') })];
    const shown = showUp({ sessions, performances: [], minimum: 2, today });
    expect(shown.weeks).toHaveLength(SHOW_UP_WEEKS);
    expect(shown.weeks[0]).toEqual({ monday: day('2029-12-24'), done: 1, met: false });
    expect(shown.weeks.at(-1)).toEqual({ monday: day('2030-03-11'), done: 2, met: true });
    expect(shown.weeks.reduce((sum, w) => sum + w.done, 0)).toBe(3);
  });

  it('marks no week met when no minimum is set', () => {
    const shown = showUp({ sessions: [done('2030-03-11')], performances: [], minimum: null, today });
    expect(shown.minimum).toBeNull();
    expect(shown.weeks.some((w) => w.met)).toBe(false);
  });
});
