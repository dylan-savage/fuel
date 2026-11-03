import { describe, expect, it } from 'vitest';
import { NotionHistory, reconcile } from '../src/domain/notionImport.js';

const MONDAY = '2030-03-04';
const ROW = `${MONDAY} Mon, Push bench-press`;

const lb = (amount: number, reps: number, note?: string) => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'total', reps }, ...(note === undefined ? {} : { note }) });
const kg = (amount: number, reps: number) => ({ load: { kind: 'weight', amount, unit: 'kg' }, reps: { kind: 'total', reps } });
const sides = (amount: number, left: number, right: number) => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'sides', left, right } });
const bw = (reps: number) => ({ load: { kind: 'bodyweight' }, reps: { kind: 'total', reps } });
const band = (reps: number) => ({ load: { kind: 'band', label: 'green' }, reps: { kind: 'total', reps } });

const bench = (sets: readonly unknown[], extra: object = {}) => ({ done: 'Bench press', sets, ...extra });

function pushDay(exercises: readonly unknown[], extra: object = {}) {
  return { label: 'Mon, Push', key: 'push', weekday: 1, date: MONDAY, pageId: 'page-1', pageEditedAt: '2030-03-04T18:00:00.000Z', exercises, skipped: [], ...extra };
}

function progressRow(extra: object = {}) {
  return { entry: 'Bench press, Mar 4', exercise: 'Bench press', day: 'Mon, Push', monday: MONDAY, topLb: 100, volume: 1000, e1rm: 133, reps: '10', keyLift: false, ...extra };
}

/** One logged session whose only Progress row agrees exactly, so each test changes one thing. */
function history(extra: object = {}): NotionHistory {
  return NotionHistory.parse({
    capturedAt: '2030-03-10',
    dateAssumption: 'Monday plus the planned weekday.',
    names: { 'Bench press': 'bench-press', 'Incline press': 'incline-press', 'Close-grip bench': 'bench-press', 'Step up': 'step-up' },
    weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])])] }],
    progress: [progressRow()],
    weekRows: [{ week: 'Week of Mar 4', monday: MONDAY, current: false, sessionsDone: 1, notes: null }],
    bodyWeight: [],
    waivers: [],
    ...extra,
  });
}

const findingsOf = (h: NotionHistory) => reconcile(h).findings.map((found) => [found.row, found.field, found.notion, found.computed]);

describe('NotionHistory', () => {
  it.each([
    ['logged', { weeks: [{ monday: MONDAY, days: [pushDay([{ done: 'Mystery lift', sets: [lb(100, 10)] }])] }] }],
    ['planned', { weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)], { planned: 'Mystery lift' })])] }] }],
    ['skipped', { weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])], { skipped: [{ planned: 'Mystery lift' }] })] }] }],
    ['in Progress', { progress: [progressRow({ exercise: 'Mystery lift' })] }],
  ])('refuses a name %s with no entry in the table', (_where, change) => {
    expect(() => history(change)).toThrow(/no lift for .*Mystery lift/);
  });

  it('refuses a day whose date is not its Monday plus its weekday', () => {
    expect(() => history({ weeks: [{ monday: MONDAY, days: [pushDay([], { date: '2030-03-05' })] }] })).toThrow(/expected 2030-03-04/);
  });
});

describe('NotionHistory slots', () => {
  it('refuses one planned lift twice on a day, because the second document would overwrite the first', () => {
    const twice = [bench([lb(100, 5)]), bench([lb(100, 5)])];
    expect(() => history({ weeks: [{ monday: MONDAY, days: [pushDay(twice)] }] })).toThrow(/plans bench-press twice/);
    expect(() => history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])], { skipped: [{ planned: 'Bench press' }] })] }] })).toThrow(/plans bench-press twice/);
  });
});

describe('reconcile', () => {
  it('finds nothing when Progress agrees with the sets', () => {
    expect(reconcile(history())).toMatchObject({ progressRows: 1, matched: 1, waivedRows: 0, findings: [], clean: true });
  });

  it('recomputes through the phone: a kg set converts exactly, and a per-side set counts both sides of volume and its better side of est. 1RM', () => {
    const weeks = (sets: readonly unknown[]) => [{ monday: MONDAY, days: [pushDay([bench(sets)])] }];
    expect(findingsOf(history({ weeks: weeks([kg(50, 10)]), progress: [progressRow({ topLb: 110.23, volume: 1102.31, e1rm: 146.97 })] }))).toEqual([[ROW, 'topLb', '110.23', '110.23']]);
    expect(findingsOf(history({ weeks: weeks([sides(50, 8, 10)]), progress: [progressRow({ topLb: 50, volume: 900, e1rm: 66.67 })] }))).toEqual([]);
  });

  it('expects blank totals for bodyweight and band sets, never zero', () => {
    const blank = { topLb: null, volume: null, e1rm: null };
    expect(findingsOf(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([bw(12), band(10)])])] }], progress: [progressRow(blank)] }))).toEqual([]);
    expect(findingsOf(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([bw(12)])])] }], progress: [progressRow({ ...blank, topLb: 0 })] }))).toEqual([[ROW, 'topLb', '0', 'blank']]);
  });

  it('reads half a pound of est. 1RM or volume as rounding, and gives top weight no slack', () => {
    expect(findingsOf(history({ progress: [progressRow({ volume: 1000.5, e1rm: 133.83 })] }))).toEqual([]);
    expect(findingsOf(history({ progress: [progressRow({ volume: 1001, e1rm: 134 })] }))).toEqual([
      [ROW, 'volume', '1001', '1000'],
      [ROW, 'e1rm', '134', '133.33'],
    ]);
    expect(findingsOf(history({ progress: [progressRow({ topLb: 100.25 })] }))).toEqual([[ROW, 'topLb', '100.25', '100']]);
  });

  it('flags a blank Progress total beside a computed number, in either direction', () => {
    expect(findingsOf(history({ progress: [progressRow({ e1rm: null })] }))).toEqual([[ROW, 'e1rm', 'blank', '133.33']]);
    expect(findingsOf(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([bw(10)])])] }], progress: [progressRow({ volume: null, e1rm: null })] }))).toEqual([[ROW, 'topLb', '100', 'blank']]);
  });

  it('reports a Progress row with no logged sets behind it', () => {
    const extra = progressRow({ exercise: 'Incline press', reps: '8/8' });
    expect(findingsOf(history({ progress: [progressRow(), extra] }))).toEqual([[`${MONDAY} Mon, Push incline-press`, 'no-logged-sets', '8/8', 'no sets']]);
  });

  it('reports logged sets with no Progress row', () => {
    expect(findingsOf(history({ progress: [] }))).toEqual([[ROW, 'no-progress-row', 'no row', 'logged sets']]);
  });

  it('joins a name that drifted through the table', () => {
    expect(findingsOf(history({ weeks: [{ monday: MONDAY, days: [pushDay([{ done: 'Close-grip bench', sets: [lb(100, 10)] }])] }] }))).toEqual([]);
  });

  it('reads two exercises of one lift on one day as one row', () => {
    const twice = [bench([lb(100, 5)]), bench([lb(100, 5)], { planned: 'Incline press' })];
    expect(findingsOf(history({ weeks: [{ monday: MONDAY, days: [pushDay(twice)] }], progress: [progressRow({ e1rm: 116.67 })] }))).toEqual([]);
  });

  it('checks sessions done per week, where a page with nothing logged is no session', () => {
    const blankPage = pushDay([], { label: 'Tue, Pull', key: 'pull', weekday: 2, date: '2030-03-05' });
    const weeks = [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])]), blankPage] }];
    expect(findingsOf(history({ weeks }))).toEqual([]);
    const row = { week: 'Week of Mar 4', monday: MONDAY, current: false, notes: null };
    expect(findingsOf(history({ weeks, weekRows: [{ ...row, sessionsDone: 2 }] }))).toEqual([[MONDAY, 'sessions-done', '2', '1']]);
    expect(findingsOf(history({ weeks, weekRows: [] }))).toEqual([[MONDAY, 'sessions-done', 'blank', '1']]);
  });

  it('checks weigh-ins in both directions', () => {
    const typed = [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])], { morningWeightLb: 170 })] }];
    const row = { entry: 'Mon Mar 4', date: MONDAY, lb: 170 };
    expect(findingsOf(history({ weeks: typed, bodyWeight: [row] }))).toEqual([]);
    expect(findingsOf(history({ weeks: typed }))).toEqual([[MONDAY, 'body-weight', 'blank', '170']]);
    expect(findingsOf(history({ bodyWeight: [row] }))).toEqual([[MONDAY, 'body-weight', '170', 'blank']]);
    expect(findingsOf(history({ weeks: typed, bodyWeight: [{ ...row, lb: 171 }] }))).toEqual([[MONDAY, 'body-weight', '171', '170']]);
  });

  it('lets a waiver clear only the row and field it names', () => {
    const wrong = [progressRow({ volume: 1001, e1rm: 134 })];
    const result = reconcile(history({ progress: wrong, waivers: [{ row: ROW, field: 'volume', reason: 'Notion rounded up.' }] }));
    expect(result.standing.map((found) => found.field)).toEqual(['e1rm']);
    expect(result.findings.find((found) => found.field === 'volume')?.waiver).toBe('Notion rounded up.');
    expect(result).toMatchObject({ matched: 0, waivedRows: 0, clean: false });
  });

  it('is clean once every disagreement is waived, and counts the row as waived, not matched', () => {
    const waivers = [{ row: ROW, field: 'volume', reason: 'Notion rounded up.' }];
    expect(reconcile(history({ progress: [progressRow({ volume: 1001 })], waivers }))).toMatchObject({ matched: 0, waivedRows: 1, standing: [], clean: true });
  });

  it('keeps a waiver that names nothing from passing quietly', () => {
    const result = reconcile(history({ waivers: [{ row: ROW, field: 'volume', reason: 'Old excuse.' }] }));
    expect(result.staleWaivers.map((waiver) => waiver.reason)).toEqual(['Old excuse.']);
    expect(result.clean).toBe(false);
  });
});
