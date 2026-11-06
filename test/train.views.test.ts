/** The Train tab's reads over a real replica, so every date bound and index is the shipped one. */
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openReplica, type Replica } from '../src/client/replica.js';
import { dayLiftIds, dayScreenView, lastTimesView, pickerView, weekView, type DayScreenView, type WeekView } from '../src/client/views.js';
import { weighInId } from '../src/domain/body.js';
import { TrainingNoteId } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Performance } from '../src/domain/lifts.js';
import type { Program } from '../src/domain/program.js';
import { lastLineOf } from '../src/domain/progress.js';
import type { Session } from '../src/domain/session.js';
import { T0, bw, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, target } from './training.fixtures.js';

const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function replicaWith(docs: { readonly programs?: readonly Program[]; readonly sessions?: readonly Session[]; readonly performances?: readonly Performance[] }) {
  const { replica } = await openReplica({ name: 'train-views', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  await put(replica, docs);
  return replica;
}

function put(replica: Replica, docs: { readonly programs?: readonly Program[]; readonly sessions?: readonly Session[]; readonly performances?: readonly Performance[] }) {
  return replica.commit([
    ...(docs.programs ?? []).map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
    ...(docs.sessions ?? []).map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...(docs.performances ?? []).map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
  ]);
}

const MONDAY = '2030-03-04';
const LATER = day('2030-03-07');
const benchDay = { key: 'push', label: 'Push', weekday: 1, blocks: [liftsBlock('main', [slot('a1', 'bench-press', 3)])] };
const rowDay = { key: 'pull', label: 'Pull', weekday: 4, blocks: [liftsBlock('main', [slot('b1', 'cable-row', 3)])] };
const pushed = (date: string) => session({ date: day(date), day: { key: dayKey('push'), label: 'Push' }, finishedAt: minutes(60) });

function required(week: WeekView | null): WeekView {
  if (week === null) throw new Error('expected a week');
  return week;
}

const doneOn = (week: WeekView, key: string) => week.days.find((d) => d.plan.key === key)?.doneOn;

describe('weekView', () => {
  it('is null before any version is in effect', async () => {
    const replica = await replicaWith({ programs: [program('2030-03-11', [benchDay])] });
    expect(await weekView(replica.read, LATER)).toBeNull();
  });

  it('keeps a day done when a version published mid-week replaces the plan', async () => {
    const done = pushed('2030-03-05');
    const monday = program(MONDAY, [benchDay, rowDay]);
    const midweek = program('2030-03-06', [{ ...benchDay, label: 'Push, renamed' }, rowDay], { publishedAt: ms(T0 + 1) });
    const replica = await replicaWith({ programs: [monday], sessions: [{ ...done, programId: monday.id }] });
    expect(doneOn(required(await weekView(replica.read, LATER)), 'push')).toBe('2030-03-05');
    await put(replica, { programs: [midweek] });
    const week = required(await weekView(replica.read, LATER));
    expect(week.days.map((d) => d.plan.label)).toEqual(['Push, renamed', 'Pull']);
    expect(doneOn(week, 'push')).toBe('2030-03-05');
  });

  it('counts an imported session with no pin and a cardio-only one without crashing, and only in their week', async () => {
    const imported = session({ date: day('2030-03-05'), day: { key: dayKey('push'), label: 'Push' }, source: 'notion', startedAt: undefined });
    const cardio = session({ date: day('2030-03-06'), day: { key: dayKey('swim'), label: 'Swim' }, source: 'notion', note: 'Invented swim.', startedAt: undefined });
    const lastWeek = session({ date: day('2030-03-03'), day: { key: dayKey('pull'), label: 'Pull' }, source: 'notion', startedAt: undefined });
    const replica = await replicaWith({ programs: [program('2030-02-25', [benchDay, rowDay])], sessions: [imported, cardio, lastWeek] });
    const week = required(await weekView(replica.read, LATER));
    expect(week.done).toBe(2);
    expect(doneOn(week, 'push')).toBe('2030-03-05');
    expect(doneOn(week, 'pull')).toBeNull();
    expect(week.strip).toEqual([true, true]);
  });

  it('shows the Sunday report as soon as it lands, before its week starts', async () => {
    const current = program(MONDAY, [benchDay], { report: { text: 'This week.' } });
    const replica = await replicaWith({ programs: [current, program('2030-03-11', [benchDay, rowDay], { report: { text: 'Next week.' } })] });
    const sunday = required(await weekView(replica.read, day('2030-03-10')));
    expect(sunday.coach).toMatchObject({ kind: 'checked-in', report: { text: 'Next week.' } });
    expect(sunday.coach.kind === 'checked-in' ? sunday.coach.changes.map((c) => c.target) : []).toEqual(['day:pull']);
    expect(sunday.days.map((d) => d.plan.key)).toEqual(['push']);
    expect(required(await weekView(replica.read, day('2030-03-11'))).coach).toMatchObject({ report: { text: 'Next week.' } });
  });

  it('keeps this week\'s report when an upcoming version has none', async () => {
    const replica = await replicaWith({ programs: [program(MONDAY, [benchDay], { report: { text: 'This week.' } }), program('2030-03-11', [benchDay])] });
    expect(required(await weekView(replica.read, LATER)).coach).toMatchObject({ report: { text: 'This week.' } });
  });

  it('derives "no check-in" from no version this week, and a check-in once one takes effect', async () => {
    const before = program('2030-02-25', [benchDay], { report: { text: 'Old report.' } });
    const replica = await replicaWith({ programs: [before] });
    expect(required(await weekView(replica.read, LATER)).coach).toEqual({ kind: 'quiet' });
    await put(replica, { programs: [program(MONDAY, [benchDay, rowDay], { report: { text: 'This week.' } })] });
    const coach = required(await weekView(replica.read, LATER)).coach;
    expect(coach).toMatchObject({ kind: 'checked-in', report: { text: 'This week.' } });
    expect(coach.kind === 'checked-in' ? coach.changes.map((c) => c.target) : []).toEqual(['day:pull']);
  });

  it('holds the week\'s notes and leaves a day\'s note off it', async () => {
    const version = program(MONDAY, [benchDay], { notes: [{ text: 'For the week.' }, { text: 'For push.', day: dayKey('push') }, { text: 'Lapsed.', onlyWeek: day('2030-02-25') }] });
    const replica = await replicaWith({ programs: [version] });
    expect(required(await weekView(replica.read, LATER)).notes.map((n) => n.text)).toEqual(['For the week.']);
  });

  it('knows whether today has a weigh-in, and nothing about other days', async () => {
    const replica = await replicaWith({ programs: [program(MONDAY, [benchDay])] });
    const on = (date: string): Mutation => ({ op: 'put', kind: 'weighIn', doc: { id: weighInId(day(date)), date: day(date), kg: 80, loggedAt: ms(T0) } });
    await replica.commit([on('2030-03-06')]);
    expect(required(await weekView(replica.read, LATER)).weighedInToday).toBe(false);
    await replica.commit([on('2030-03-07')]);
    expect(required(await weekView(replica.read, LATER)).weighedInToday).toBe(true);
  });
});

describe('weekView as a live query', () => {
  it('re-reads the version before when it arrives after the one in effect, as a re-pull can bring them', async () => {
    Object.assign(Dexie.dependencies, { indexedDB: new IDBFactory(), IDBKeyRange });
    const replica = await replicaWith({ programs: [program(MONDAY, [benchDay, rowDay], { report: { text: 'This week.' } })] });
    const weeks: (WeekView | null)[] = [];
    const stop = replica.live((r) => weekView(r, LATER)).subscribe((week) => weeks.push(week));
    await vi.waitFor(() => expect(weeks).toHaveLength(1));
    expect(weeks[0]?.coach).toMatchObject({ kind: 'checked-in', changes: [] });

    await put(replica, { programs: [program('2030-02-25', [benchDay])] });
    await vi.waitFor(() => {
      const coach = weeks.at(-1)?.coach;
      expect(coach?.kind === 'checked-in' ? coach.changes.map((c) => c.target) : []).toEqual(['day:pull']);
    });
    stop();
  });
});

describe('dayScreenView', () => {
  const superset = liftsBlock('pair', [slot('a1', 'bench-press', 3, { target: target(3, 8, 12) }), slot('a2', 'cable-row', 3, { target: target(3, 8, 12, { perSide: 'left-first' }) })], { restSeconds: 75 });
  const version = program(MONDAY, [
    {
      key: 'push',
      label: 'Push',
      blocks: [liftsBlock('extra', [slot('e1', 'crunch', 2)], { optional: true }), checklist('warm'), superset, checklist('retest', { onlyWeek: day('2030-02-25') })],
    },
  ]);
  const PUSH = dayKey('push');
  const today = { key: PUSH, date: LATER };
  const held = (view: DayScreenView | null): DayScreenView => {
    if (view === null) throw new Error('expected a day');
    return view;
  };

  it('reads notes, then blocks with lapsed ones gone and optional ones last, for that day only', async () => {
    const replica = await replicaWith({ programs: [{ ...version, notes: [{ text: 'For push.', day: PUSH }, { text: 'For the week.' }] }] });
    const view = held(await dayScreenView(replica.read, today));
    expect(view.notes.map((n) => n.text)).toEqual(['For push.']);
    expect(view.parts.map((p) => p.block.id)).toEqual(['warm', 'pair', 'extra']);
    expect(view.parts[1]?.superset).toEqual({ rounds: 3 });
    expect(await dayScreenView(replica.read, { key: dayKey('legs'), date: LATER })).toBeNull();
  });

  it('reads the version in effect with nothing logged, and has no session to show', async () => {
    const replica = await replicaWith({ programs: [version] });
    expect(held(await dayScreenView(replica.read, today))).toMatchObject({ session: null, performances: [], cardioDone: false, plan: { label: 'Push' } });
  });

  it('reads the pinned version once the day has a session, and the newer one on another date', async () => {
    const newer = program('2030-03-07', [{ key: 'push', label: 'Push, renamed', blocks: [superset] }], { publishedAt: ms(T0 + 1) });
    const pinned = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: version.id });
    const replica = await replicaWith({ programs: [version, newer], sessions: [pinned] });
    expect(held(await dayScreenView(replica.read, today)).plan.label).toBe('Push');
    expect(held(await dayScreenView(replica.read, { key: PUSH, date: day('2030-03-08') })).plan.label).toBe('Push, renamed');
  });

  it('falls back to the version in effect when this phone does not hold the pin', async () => {
    const unheld = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: program('2029-01-07', [benchDay]).id });
    const replica = await replicaWith({ programs: [version], sessions: [unheld] });
    expect(held(await dayScreenView(replica.read, today))).toMatchObject({ plan: { label: 'Push' }, session: { id: unheld.id } });
  });

  it('holds only that day\'s session and sets on that date', async () => {
    const pulled = session({ date: LATER, day: { key: dayKey('pull'), label: 'Pull' }, programId: version.id });
    const mine = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: version.id });
    const earlier = session({ date: day('2030-03-05'), day: { key: PUSH, label: 'Push' }, programId: version.id });
    const replica = await replicaWith({
      programs: [version],
      sessions: [pulled, mine, earlier],
      performances: [performance({ session: mine.id, date: '2030-03-07', slot: 'a1', lift: 'bench-press', sets: [lb(100, 8, 1)] }), performance({ session: pulled.id, date: '2030-03-07', slot: 'b1', lift: 'cable-row', sets: [lb(50, 8, 1)] }), performance({ session: earlier.id, date: '2030-03-05', slot: 'a1', lift: 'bench-press', sets: [lb(90, 8, 1)] })],
    });
    const view = held(await dayScreenView(replica.read, today));
    expect(view.session?.id).toBe(mine.id);
    expect(view.performances.map((p) => p.sets[0]?.load)).toEqual([lb(100, 8).load]);
  });

  it('shows last-time lines as typed, in kg, per side and under an alias, through the read the day makes', async () => {
    const withAlias = { ...version, lifts: version.lifts.map((l) => (l.id === 'bench-press' ? { ...l, aliases: [lift('flat-bench')] } : l)) };
    const replica = await replicaWith({
      programs: [withAlias],
      performances: [
        performance({ date: '2030-03-01', lift: 'flat-bench', sets: [kg(62.5, 8), kg(62.5, 8), kg(60, 6)] }),
        performance({ date: '2030-02-28', lift: 'cable-row', sets: [sides(30, 10, 9)] }),
        performance({ date: '2030-02-20', lift: 'cable-row', sets: [sides(25, 12, 12)] }),
      ],
    });
    const view = held(await dayScreenView(replica.read, today));
    const rows = await lastTimesView(replica.read, dayLiftIds(view, []), LATER);
    const lastOf = (name: string) => lastLineOf({ lift: lift(name), rows, book: view.book, before: LATER });
    expect(lastOf('bench-press')).toEqual({ date: '2030-03-01', line: '60–62.5 kg × 8/8/6', addWeight: false });
    expect(lastOf('cable-row')).toEqual({ date: '2030-02-28', line: '30 lb × 10+9', addWeight: false });
    expect(lastOf('crunch')).toBeNull();
  });

  it('holds that date\'s added exercises, in the order he started them', async () => {
    const mine = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: version.id });
    const replica = await replicaWith({
      programs: [version],
      sessions: [mine],
      performances: [
        performance({ session: mine.id, date: '2030-03-07', lift: 'calf-raise', label: 'Calf raise', sets: [bw(20, 5)] }),
        performance({ session: mine.id, date: '2030-03-07', slot: 'a1', lift: 'bench-press', sets: [lb(100, 8, 1)] }),
        performance({ session: mine.id, date: '2030-03-07', lift: 'tib-raise', label: 'Tib raise', sets: [bw(15, 2)] }),
      ],
    });
    expect(held(await dayScreenView(replica.read, today)).added).toEqual([
      { liftId: lift('tib-raise'), label: 'Tib raise' },
      { liftId: lift('calf-raise'), label: 'Calf raise' },
    ]);
  });

  it('holds that date\'s lines, which the Note sheet sorts by what they are about', async () => {
    const replica = await replicaWith({ programs: [version] });
    const line = (date: string, n: number) => ({ id: TrainingNoteId.parse(`3d4f7d8b-4a3e-4f6b-9cad-1e2f3a4b5c6${n}`), date: day(date), text: `Invented line ${n}.`, at: ms(T0 + n) });
    await replica.commit([line('2030-03-07', 1), line('2030-03-06', 2)].map((doc): Mutation => ({ op: 'put', kind: 'trainingNote', doc })));
    expect(held(await dayScreenView(replica.read, today)).trainingNotes.map((note) => note.text)).toEqual(['Invented line 1.']);
  });

  it('asks last time of a swap or an added lift with no set yet, and of what the day has logged', async () => {
    const replica = await replicaWith({ programs: [version] });
    const view = held(await dayScreenView(replica.read, today));
    expect(dayLiftIds(view, [])).not.toContain('landmine-press');
    expect(dayLiftIds(view, [{ liftId: lift('landmine-press') }])).toContain('landmine-press');
    expect(dayLiftIds({ ...view, performances: [performance({ lift: 'seal-row', sets: [lb(50, 8)] })] }, [])).toContain('seal-row');
  });

  it('re-runs on a set today, while the last-time read does not until an earlier day changes', async () => {
    // A live query only runs where Dexie found a global indexedDB, which Node has none of.
    Object.assign(Dexie.dependencies, { indexedDB: new IDBFactory(), IDBKeyRange });
    const older = performance({ date: '2030-03-01', lift: 'bench-press', sets: [lb(100, 8)] });
    const replica = await replicaWith({ programs: [version], performances: [older] });
    let lastRuns = 0;
    const views: (DayScreenView | null)[] = [];
    const reads: (readonly Performance[])[] = [];
    const stopDay = replica.live((r) => dayScreenView(r, today)).subscribe((view) => views.push(view));
    const stopLast = replica
      .live((r) => {
        lastRuns++;
        return lastTimesView(r, [lift('bench-press')], LATER);
      })
      .subscribe((rows) => reads.push(rows));
    await vi.waitFor(() => expect(views).toHaveLength(1));
    await vi.waitFor(() => expect(reads).toHaveLength(1));

    const mine = session({ date: LATER, day: { key: PUSH, label: 'Push' }, programId: version.id });
    await put(replica, { sessions: [mine], performances: [performance({ session: mine.id, date: '2030-03-07', slot: 'a1', lift: 'bench-press', sets: [lb(110, 8, 1)] })] });
    await vi.waitFor(() => expect(views.at(-1)?.performances).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastRuns).toBe(1);

    await put(replica, { performances: [{ ...older, sets: [lb(105, 8)] }] });
    await vi.waitFor(() => expect(reads.at(-1)?.[0]?.sets[0]).toEqual(lb(105, 8)));
    expect(lastRuns).toBe(2);
    stopDay();
    stopLast();
  });
});

describe('pickerView', () => {
  it('reads this day\'s sessions in the weeks before the date, and each lift\'s newest row', async () => {
    const PUSH = dayKey('push');
    const on = (date: string, key = PUSH) => session({ date: day(date), day: { key, label: key }, finishedAt: minutes(60) });
    const inside = on('2030-02-25');
    const tooOld = on('2030-01-09');
    const otherDay = on('2030-03-01', dayKey('pull'));
    const today = on('2030-03-07');
    const row = (of: Session, name: string) => performance({ session: of.id, date: of.date, lift: name, sets: [bw(20)] });
    const replica = await replicaWith({
      sessions: [inside, tooOld, otherDay, today],
      performances: [row(inside, 'calf-raise'), row(tooOld, 'tib-raise'), row(otherDay, 'seal-row'), row(today, 'leg-press')],
    });
    const view = await pickerView(replica.read, { key: PUSH, date: LATER });
    expect(view.dayHistory.map((p) => p.liftId)).toEqual(['calf-raise']);
    expect(view.newest.map((p) => p.liftId).toSorted()).toEqual(['calf-raise', 'leg-press', 'seal-row', 'tib-raise']);
  });
});
