/** The domain reads under the Progress sheet. Every number here is invented. */
import { describe, expect, it } from 'vitest';
import { liftBook, type Performance } from '../src/domain/lifts.js';
import {
  boardRow,
  latestOf,
  latestRepsToGo,
  lineOf,
  liftSeries,
  liftSeriesByRange,
  loggedLifts,
  recentSessions,
  repsToGo,
  setsLine,
  staleBest,
  weekUnfinished,
  type LiftRead,
} from '../src/domain/progress.js';
import { band, bw, day, kg, lb, lift, performance, sides, target, warm } from './training.fixtures.js';

const noCatalog = liftBook([]);
const read = (name: string, rows: readonly Performance[]): LiftRead => ({ lift: lift(name), rows, book: noCatalog });

describe('setsLine', () => {
  it('writes each set as typed, leaving pounds unwritten and every other unit in', () => {
    expect(setsLine([lb(50, 12), lb(50, 12), lb(47.5, 10)])).toBe('50 × 12, 50 × 12, 47.5 × 10');
    expect(setsLine([kg(20, 12), lb(45, 10)])).toBe('20 kg × 12, 45 × 10');
    expect(setsLine([bw(11), band('green', 12), sides(30, 10, 9)])).toBe('BW × 11, green × 12, 30 × 10+9');
  });
});

describe('repsToGo', () => {
  it('says how many sets the range asks for, whatever was done', () => {
    const three = target(3, 8, 12);
    expect(repsToGo(performance({ lift: 'squat', sets: [lb(100, 12), lb(100, 12), lb(100, 12), lb(100, 9)], target: three }))?.prescribed).toBe(3);
    expect(repsToGo(performance({ lift: 'squat', sets: [lb(100, 12)], target: three }))?.prescribed).toBe(3);
  });
});

describe('recentSessions', () => {
  const rows = (...sets: readonly (readonly Parameters<typeof performance>[0]['sets'][number][])[]) =>
    sets.map((one, i) => performance({ lift: 'squat', date: `2030-03-0${i + 1}`, sets: one }));

  it('splits a row into the top load as typed and the reps at that load', () => {
    const [row] = recentSessions(read('squat', rows([lb(55, 12), lb(55, 11), lb(50, 9)])), 1);
    expect(row).toMatchObject({ load: '55 lb', reps: '12, 11', added: null });
  });

  it('keeps warm-ups out of a row', () => {
    const [row] = recentSessions(read('squat', rows([warm(lb(90, 5)), lb(55, 12)])), 1);
    expect(row).toMatchObject({ load: '55 lb', reps: '12' });
  });

  it('says what was added in the unit typed, across a change of unit', () => {
    const recent = recentSessions(read('squat', rows([lb(50, 8)], [lb(55, 8)], [lb(55, 12)], [kg(20, 8)], [kg(30, 8)], [lb(70, 8)])), 6);
    expect(recent.map((r) => r.added)).toEqual([{ amount: 3.9, unit: 'lb' }, { amount: 10, unit: 'kg' }, null, null, { amount: 5, unit: 'lb' }, null]);
  });

  it('writes a session with no weight by what it was loaded with, per side reps included', () => {
    const recent = recentSessions(read('squat', rows([bw(10), bw(9)], [band('green', 12), band('red', 8)], [sides(30, 10, 9)])), 3);
    expect(recent.map((r) => [r.load, r.reps])).toEqual([
      ['30 lb', '10+9'],
      ['green/red', '12, 8'],
      ['BW', '10, 9'],
    ]);
  });
});

describe('latestRepsToGo', () => {
  const range = target(3, 8, 12);
  const before = day('2030-04-01');

  it('reads the newest session with a working set, past a day of only warm-ups', () => {
    const rows = [performance({ lift: 'squat', date: '2030-03-01', sets: [lb(55, 10), lb(55, 9), lb(55, 9)], target: range }), performance({ lift: 'squat', date: '2030-03-08', sets: [warm(lb(30, 10))], target: range })];
    expect(latestRepsToGo({ ...read('squat', rows), before })).toMatchObject({ missing: 8, top: 12 });
  });

  it('is null with nothing done, and on a bodyweight or band session', () => {
    expect(latestRepsToGo({ ...read('squat', []), before })).toBeNull();
    const rows = [performance({ lift: 'dip', date: '2030-03-01', sets: [bw(12)], target: target(3, 8, 12, { load: 'bodyweight' }) })];
    expect(latestRepsToGo({ ...read('dip', rows), before })).toBeNull();
  });
});

describe('lineOf and latestOf', () => {
  it('bridge a bodyweight or band day of a loaded lift rather than dipping to 0', () => {
    const rows = [
      performance({ lift: 'pull-up', date: '2030-03-01', sets: [lb(30, 5)] }),
      performance({ lift: 'pull-up', date: '2030-03-08', sets: [bw(10)] }),
      performance({ lift: 'pull-up', date: '2030-03-15', sets: [band('green', 10)] }),
      performance({ lift: 'pull-up', date: '2030-03-22', sets: [lb(35, 5)] }),
      performance({ lift: 'pull-up', date: '2030-03-29', sets: [bw(11)] }),
    ];
    const series = liftSeries(read('pull-up', rows));
    expect(series.points).toHaveLength(5);
    expect(lineOf(series).map((p) => p.date)).toEqual(['2030-03-01', '2030-03-22']);
    expect(lineOf(series).every((p) => p.value > 0)).toBe(true);
    expect(latestOf(series)?.date).toBe('2030-03-22');
  });

  it('plot best reps for a lift with no weighted sets, and nothing with no sessions', () => {
    const series = liftSeries(read('dip', [performance({ lift: 'dip', date: '2030-03-01', sets: [bw(8), bw(10)] })]));
    expect(lineOf(series)).toEqual([{ date: day('2030-03-01'), value: 10 }]);
    expect(lineOf(liftSeries(read('dip', [])))).toEqual([]);
    expect(latestOf(liftSeries(read('dip', [])))).toBeNull();
  });
});

describe('liftSeriesByRange', () => {
  const today = day('2030-06-30');
  const rows = [
    performance({ lift: 'squat', date: '2028-06-01', sets: [lb(300, 5)] }),
    performance({ lift: 'squat', date: '2030-01-15', sets: [lb(250, 5)] }),
    performance({ lift: 'leg-press', planned: 'squat', date: '2030-01-22', label: 'Leg press', sets: [lb(400, 12)] }),
    performance({ lift: 'squat', date: '2030-06-01', sets: [lb(200, 5)] }),
  ];

  it('rings the best of what each range shows, with swaps scoped the same way', () => {
    const ranges = liftSeriesByRange({ ...read('squat', rows), today });
    expect(ranges['3m'].best?.date).toBe('2030-06-01');
    expect(ranges['3m'].swaps).toEqual([]);
    expect(ranges['1y'].best?.date).toBe('2030-01-15');
    expect(ranges['1y'].swaps.map((s) => s.date)).toEqual(['2030-01-22']);
    expect(ranges.all.best?.date).toBe('2028-06-01');
  });

  it('leaves a session exactly on the range edge out, as the board does', () => {
    const edge = [performance({ lift: 'squat', date: '2030-03-31', sets: [lb(100, 5)] }), performance({ lift: 'squat', date: '2030-04-01', sets: [lb(100, 5)] })];
    expect(liftSeriesByRange({ ...read('squat', edge), today })['3m'].points.map((p) => p.date)).toEqual(['2030-04-01']);
  });
});

describe('staleBest', () => {
  const today = day('2030-06-02');
  const row = (values: readonly number[]) => boardRow({ ...read('squat', values.map((v, i) => performance({ lift: 'squat', date: `2030-05-${String(i + 10)}`, sets: [lb(v, 5)] }))), today });

  it('says nothing for a session or two past the best, and speaks from the third', () => {
    expect(staleBest(row([100, 110, 105, 105]))).toBeNull();
    expect(staleBest(row([100, 110, 105, 105, 105, 105, 105]))).toBe(5);
    expect(staleBest(row([]))).toBeNull();
  });
});

describe('weekUnfinished', () => {
  it('reads the minimum first, then the plan', () => {
    expect(weekUnfinished(1, 3, 4)).toBe(true);
    expect(weekUnfinished(3, 3, 4)).toBe(false);
    expect(weekUnfinished(1, null, 4)).toBe(true);
    expect(weekUnfinished(4, null, 4)).toBe(false);
    expect(weekUnfinished(0, null, 0)).toBe(false);
  });
});

describe('loggedLifts', () => {
  const book = liftBook([{ id: lift('squat'), name: 'Back squat', aliases: [lift('barbell-squat')] }]);

  it('lists most recent first, folds an alias into its lift, and names an uncataloged lift by its label', () => {
    const rows = [
      performance({ lift: 'squat', date: '2030-03-01', sets: [lb(100, 5)] }),
      performance({ lift: 'barbell-squat', date: '2030-03-15', sets: [lb(100, 5)] }),
      performance({ lift: 'sled-push', label: 'Sled push', date: '2030-03-08', sets: [lb(100, 5)] }),
    ];
    expect(loggedLifts(rows, book)).toEqual([
      { liftId: 'squat', name: 'Back squat', lastDate: '2030-03-15' },
      { liftId: 'sled-push', name: 'Sled push', lastDate: '2030-03-08' },
    ]);
  });

  it('breaks a tie on date by name, so the list holds still', () => {
    const rows = [performance({ lift: 'b-lift', label: 'B', date: '2030-03-01', sets: [lb(1, 1)] }), performance({ lift: 'a-lift', label: 'A', date: '2030-03-01', sets: [lb(1, 1)] })];
    expect(loggedLifts(rows, noCatalog).map((l) => l.name)).toEqual(['A', 'B']);
  });
});
