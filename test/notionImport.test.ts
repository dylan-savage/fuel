import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { budgetOn, goalId, KG_PER_LB, PROFILE_ID, type Goal, type Profile } from '../src/domain/goals.js';
import { Performance } from '../src/domain/lifts.js';
import { NotionHistory, datesFromCutover, detailsOf, importDocs, reconcile, summaryOf, targetShift, weighInPlan, type ImportDocs } from '../src/domain/notionImport.js';
import { sessionsDone, skipsOf, totalsOf, workingSets } from '../src/domain/progress.js';
import { Session } from '../src/domain/session.js';
import { at, entry, newEntryId } from './fixtures.js';
import { day } from './training.fixtures.js';

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
    cutover: '2030-04-01',
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

/** The same shape as the script's ids: a UUID that depends only on its seed. */
function uuidFrom(seed: string): string {
  const hash = createHash('sha1').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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

describe('importDocs', () => {
  const docs = (h: NotionHistory = history()): ImportDocs => importDocs(h, uuidFrom);

  it('is the same bytes on every run, so a re-run writes nothing new', () => {
    expect(JSON.stringify(docs())).toBe(JSON.stringify(docs()));
  });

  it('derives ids from date and day, so another day or date is another session', () => {
    const id = (day: object) => docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])], day)] }], progress: [], weekRows: [] })).sessions[0]?.id;
    expect(id({})).toBeDefined();
    expect(id({ key: 'pull' })).not.toBe(id({}));
    expect(id({ weekday: 2, date: '2030-03-05' })).not.toBe(id({}));
  });

  it('gives a page with nothing logged no session, and a logged page one the coach counts', () => {
    const blankPage = pushDay([], { label: 'Tue, Pull', key: 'pull', weekday: 2, date: '2030-03-05' });
    const { sessions, performances } = docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])]), blankPage] }] }));
    expect(sessions.map((session) => session.day?.key)).toEqual(['push']);
    expect(sessionsDone(sessions, performances)).toHaveLength(1);
  });

  it('builds documents that survive their domain schemas with nothing dropped', () => {
    const h = history({
      weeks: [
        {
          monday: MONDAY,
          days: [
            pushDay([bench([lb(100, 10, 'Felt a pinch.'), kg(40, 8), sides(30, 8, 9), bw(12), band(15)], { planned: 'Incline press', target: { sets: 3, reps: { min: 8, max: 10 }, perSide: 'left-first', load: 'weight' }, note: 'Machine taken.' })], {
              note: 'Short on time.',
              checked: ['warm'],
              skipped: [{ planned: 'Step up', note: 'No box free.' }],
            }),
          ],
        },
      ],
    });
    const { sessions, performances } = docs(h);
    expect(sessions).toHaveLength(1);
    expect(performances).toHaveLength(1);
    for (const session of sessions) expect(Session.parse(JSON.parse(JSON.stringify(session)))).toEqual(session);
    for (const performance of performances) expect(Performance.parse(JSON.parse(JSON.stringify(performance)))).toEqual(performance);
  });

  it('holds what its schema refuses as a failure, not a dropped set', () => {
    const tooLong = 'x'.repeat(281);
    expect(() => docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10, tooLong)])])] }] }))).toThrow();
  });

  it('marks every session as an import, with no program, times or workout', () => {
    const [session] = docs().sessions;
    expect(session).toMatchObject({ date: MONDAY, day: { key: 'push', label: 'Mon, Push' }, source: 'notion' });
    expect(session).not.toHaveProperty('programId');
    expect(session).not.toHaveProperty('startedAt');
    expect(session).not.toHaveProperty('finishedAt');
  });

  it('logs a swap under the lift really done, with the planned lift kept', () => {
    const [performance] = docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([{ done: 'Incline press', planned: 'Bench press', sets: [lb(80, 10)] }])] }], progress: [], waivers: [] })).performances;
    expect(performance).toMatchObject({ liftId: 'incline-press', plannedLiftId: 'bench-press', label: 'Incline press', slotId: 'bench-press' });
  });

  it('treats a rename within one lift as no swap, keeping the name he used as the label', () => {
    const [performance] = docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([{ done: 'Close-grip bench', planned: 'Bench press', sets: [lb(100, 10)] }])] }] })).performances;
    expect(performance).toMatchObject({ liftId: 'bench-press', label: 'Close-grip bench' });
    expect(performance).not.toHaveProperty('plannedLiftId');
  });

  it('keeps weights as typed, with every set a working set and no invented time', () => {
    const typed = [kg(40, 8), lb(50, 10)];
    const [performance] = docs(history({ weeks: [{ monday: MONDAY, days: [pushDay([bench(typed)])] }], progress: [] })).performances;
    expect(performance?.sets).toEqual(typed);
    expect(workingSets(performance?.sets ?? [])).toHaveLength(2);
  });

  it('computes the same totals on its documents as reconcile compared', () => {
    const [performance] = docs().performances;
    expect(totalsOf(performance?.sets ?? [])).toEqual({ topLb: 100, volumeLb: 1000, e1rmLb: 100 * (1 + 10 / 30) });
  });

  it('shows a skip under its planned lift, with his note, on the coach read that has no plan', () => {
    const h = history({ weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])], { skipped: [{ planned: 'Step up', note: 'No box free.' }] })] }] });
    const { sessions, performances } = docs(h);
    const [session] = sessions;
    if (session === undefined) throw new Error('no session');
    expect(skipsOf({ session, performances, plan: undefined, phase: 'imported' })).toEqual([{ slotId: 'step-up', label: 'step-up', note: 'No box free.' }]);
  });
});

describe('a cardio-only day', () => {
  const swimDay = pushDay([], { label: 'Fri, Legs', key: 'legs', weekday: 5, date: '2030-03-08', cardioOnly: 'The week row says Friday was a swim.' });
  const week = [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])]), swimDay] }];
  const counted = { weeks: week, weekRows: [{ week: 'Week of Mar 4', monday: MONDAY, current: false, sessionsDone: 2, notes: 'Friday was a swim.' }] };

  it('is a session with no performances, carrying the note, so its week row reconciles with no waiver', () => {
    const h = history(counted);
    expect(reconcile(h)).toMatchObject({ findings: [], clean: true });
    const { sessions, performances } = importDocs(h, uuidFrom);
    const [, swim] = sessions;
    expect(swim).toMatchObject({ date: '2030-03-08', day: { key: 'legs', label: 'Fri, Legs' }, source: 'notion', note: 'The week row says Friday was a swim.' });
    expect(performances.filter((p) => p.sessionId === swim?.id)).toEqual([]);
    expect(sessionsDone(sessions, performances)).toHaveLength(2);
  });

  it('stands out as a mismatch without the flag, so a row counting a day with nothing behind it is still caught', () => {
    const plain = { ...swimDay, cardioOnly: undefined };
    expect(findingsOf(history({ ...counted, weeks: [{ monday: MONDAY, days: [pushDay([bench([lb(100, 10)])]), plain] }] }))).toEqual([[MONDAY, 'sessions-done', '2', '1']]);
  });

  it.each([
    ['logged sets', { exercises: [bench([lb(100, 10)])] }],
    ['a skip', { skipped: [{ planned: 'Step up' }] }],
    ['another note', { note: 'Which note wins?' }],
  ])('refuses one holding %s', (_what, extra) => {
    expect(() => history({ weeks: [{ monday: MONDAY, days: [{ ...swimDay, ...extra }] }] })).toThrow(/cardio only/);
  });
});

describe('datesFromCutover', () => {
  it('names a session dated on or after the cutover, and none before', () => {
    const docs = importDocs(history(), uuidFrom);
    expect(datesFromCutover(docs, day('2030-03-05'))).toEqual([]);
    expect(datesFromCutover(docs, day(MONDAY))).toEqual([MONDAY]);
    expect(datesFromCutover(docs, day('2030-03-01'))).toEqual([MONDAY]);
  });
});

describe('weighInPlan', () => {
  const readings = [
    { entry: 'Sat Mar 2', date: '2030-03-02', lb: 180 },
    { entry: 'Wed Mar 6', date: '2030-03-06', lb: 184 },
  ];
  const withReadings = () => history({ bodyWeight: readings });
  const inFuel = (date: string) => ({ id: `w:${date}`, date: day(date), kg: 83, loggedAt: at(5) });

  it('splits at fuel\'s first weigh-in, keeping that date with the newer ones', () => {
    const plan = weighInPlan(withReadings(), [inFuel('2030-03-09'), inFuel('2030-03-06')]);
    expect(plan.firstInFuel).toBe('2030-03-06');
    expect(plan.older.map((w) => w.date)).toEqual(['2030-03-02']);
    expect(plan.newer.map((w) => w.date)).toEqual(['2030-03-06']);
  });

  it('counts every one as older when fuel has none, because nothing has seeded the trend', () => {
    const plan = weighInPlan(withReadings(), []);
    expect(plan.firstInFuel).toBeNull();
    expect(plan.newer).toEqual([]);
    expect(plan.older.map((w) => w.date)).toEqual(['2030-03-02', '2030-03-06']);
  });

  it('builds the same bytes every run, in kg at the exact factor', () => {
    const doc = weighInPlan(withReadings(), []).older[0];
    expect(doc).toEqual({ id: 'w:2030-03-02', date: '2030-03-02', kg: 180 * KG_PER_LB, loggedAt: Date.parse('2030-03-02T12:00:00Z') });
    expect(JSON.stringify(weighInPlan(withReadings(), []))).toBe(JSON.stringify(weighInPlan(withReadings(), [])));
  });
});

describe('targetShift', () => {
  const profile: Profile = { id: PROFILE_ID, sex: 'male', birthDate: day('1990-01-01'), heightCm: 180, weightKg: 80 };
  const goal: Goal = { id: goalId(day('2030-03-01')), effectiveFrom: day('2030-03-01'), policy: { kind: 'activity-level', level: 'moderate' }, kgPerWeek: 0, macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 } };
  const onDates = (...dates: readonly string[]) => dates.map((date) => entry(newEntryId(), 300, date));
  const reading = (date: string, kg: number) => ({ id: `w:${date}`, date: day(date), kg, loggedAt: at(5) });
  const facts = { goals: [goal], profile, workouts: [], before: [] };

  it('compares the real budget on each diary day, once, oldest first', () => {
    const after = [reading('2030-03-02', 82)];
    const shift = targetShift({ ...facts, entries: onDates('2030-03-03', '2030-03-01', '2030-03-03'), after });
    const on = (weighIns: typeof after, date: string) => budgetOn({ goals: [goal], profile, workouts: [], weighIns, date: day(date) })?.kcal;
    expect(shift.days).toEqual([
      { date: '2030-03-01', before: on([], '2030-03-01'), after: on(after, '2030-03-01'), change: 0 },
      { date: '2030-03-03', before: on([], '2030-03-03'), after: on(after, '2030-03-03'), change: 31 },
    ]);
    expect(shift.largest?.date).toBe('2030-03-03');
  });

  it('takes the largest change in either direction', () => {
    const shift = targetShift({ ...facts, entries: onDates('2030-03-03', '2030-03-05'), after: [reading('2030-03-02', 79), reading('2030-03-04', 60)] });
    expect(shift.largest?.date).toBe('2030-03-05');
    expect(shift.largest?.change).toBeLessThan(0);
  });

  it('leaves out a diary day before the goal, and has no largest with nothing to compare', () => {
    expect(targetShift({ ...facts, entries: onDates('2030-02-28'), after: [reading('2030-02-27', 82)] })).toEqual({ days: [], largest: null });
    expect(targetShift({ ...facts, profile: undefined, entries: onDates('2030-03-03'), after: [reading('2030-03-02', 82)] })).toEqual({ days: [], largest: null });
    expect(targetShift({ ...facts, entries: [], after: [reading('2030-03-02', 82)] })).toEqual({ days: [], largest: null });
  });
});

describe('the report', () => {
  const summary = (h: NotionHistory) => summaryOf({ history: h, result: reconcile(h), docs: importDocs(h, uuidFrom), digest: 'abc123' });

  it('gives counts and the digest', () => {
    const text = summary(history());
    expect(text).toContain('Sessions 1, performances 1, sets 1, lifts 1.');
    expect(text).toContain('Progress rows 1: matched 1, waived 0, standing 0.');
    expect(text).toContain('Documents digest abc123.');
  });

  it('names what stands', () => {
    expect(summary(history({ progress: [progressRow({ volume: 1001 })] }))).toContain(`- ${ROW}, volume: Notion 1001, computed 1000`);
  });

  it('counts waivers by reason', () => {
    const waivers = [
      { row: ROW, field: 'volume', reason: 'Notion rounded up.' },
      { row: ROW, field: 'e1rm', reason: 'Notion rounded up.' },
    ];
    const text = summary(history({ progress: [progressRow({ volume: 1001, e1rm: 134 })], waivers }));
    expect(text).toContain('- 2 × Notion rounded up.');
    expect(text).toContain('Progress rows 1: matched 0, waived 1, standing 0.');
  });

  it('lists every name that is not its own slug, so a drift stays visible', () => {
    const h = history();
    const text = detailsOf(h, reconcile(h));
    expect(text).toContain('- Close-grip bench → bench-press');
    expect(text).not.toContain('- Step up');
  });

  it('puts every session date beside the page edit time, under the stated assumption', () => {
    const h = history();
    const text = detailsOf(h, reconcile(h));
    expect(text).toContain('Monday plus the planned weekday.');
    expect(text).toContain(`- ${MONDAY} Mon, Push: page last edited 2030-03-04T18:00:00.000Z`);
  });
});
