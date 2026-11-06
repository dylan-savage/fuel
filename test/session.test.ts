import { describe, expect, it } from 'vitest';
import { makeWorkout, type Workout } from '../src/domain/burn.js';
import { WorkoutId } from '../src/domain/ids.js';
import { Performance, liftBook, type SetLog } from '../src/domain/lifts.js';
import type { Slot } from '../src/domain/program.js';
import {
  addedOn,
  afterSet,
  blockDone,
  cardioDoneOn,
  cueFor,
  entryOfSet,
  exerciseLog,
  finishDocs,
  finishOf,
  isOn,
  leftEmpty,
  liftInSlot,
  liftsOnDay,
  prefillSet,
  reopened,
  sessionForDay,
  sessionPhase,
  sessionWorkoutDraft,
  sessionWorkoutId,
  setLogOf,
  sideOrder,
  steppedLoad,
  steppedReps,
  trainedLately,
  withChecked,
  withEditedSet,
  withSet,
  withSkip,
  withoutSkip,
  type Session,
} from '../src/domain/session.js';
import { T0, band, blockId, bw, cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, session, sides, slot, slotId, target, warm } from './training.fixtures.js';

const noCatalog = liftBook([]);

const a1 = (...sets: SetLog[]) => performance({ slot: 'a1', lift: 'bench-press', sets });
const a2 = (...sets: SetLog[]) => performance({ slot: 'a2', lift: 'cable-row', sets });
const swappedA2 = (...sets: SetLog[]) => performance({ slot: 'a2', lift: 'dumbbell-row', planned: 'cable-row', sets });

describe('prefillSet past last time', () => {
  it('repeats the set before it today when last time had no set at this position', () => {
    const last = performance({ lift: 'bench-press', date: '2030-02-01', sets: [lb(50, 12)] });
    const today = performance({ lift: 'bench-press', sets: [lb(50, 11)] });
    expect(prefillSet({ lift: lift('bench-press'), book: noCatalog, target: target(3, 8, 12), today: [today], last }).reps).toEqual({ kind: 'total', reps: 11 });
  });
});

describe('prefillSet', () => {
  const benchPress = lift('bench-press');
  const threeByTen = target(3, 8, 10);
  const lastTime = performance({ date: '2030-02-25', lift: 'bench-press', sets: [lb(100, 10), lb(100, 9), lb(95, 8)] });
  const fill = (today: readonly Performance[], last: Performance | undefined, t = threeByTen, id = benchPress) => prefillSet({ lift: id, book: noCatalog, target: t, today, last });

  it('starts from last time at this position', () => {
    expect(fill([], lastTime)).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 10 } });
  });

  it('takes the load from the previous set today and the reps from last time at this position', () => {
    expect(fill([a1(lb(105, 8, 1))], lastTime)).toEqual({ load: lb(105, 8).load, reps: { kind: 'total', reps: 9 } });
  });

  it('falls to last time\'s last load, and past its sets to the set before it today', () => {
    const short = performance({ date: '2030-02-25', lift: 'bench-press', sets: [lb(100, 10)] });
    expect(prefillSet({ lift: benchPress, book: noCatalog, target: threeByTen, today: [], last: short }).load).toEqual(lb(100, 10).load);
    const pastEnd = fill([a1(lb(100, 10, 1), lb(100, 10, 2), lb(100, 10, 3), lb(100, 10, 4))], lastTime);
    expect(pastEnd).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 10 } });
  });

  it('starts at the bottom of the range with nothing to repeat', () => {
    expect(fill([], undefined)).toMatchObject({ reps: { kind: 'total', reps: 8 } });
  });

  it('never fills a working set from a warm-up, today or last time', () => {
    const warmedLast = performance({ date: '2030-02-25', lift: 'bench-press', sets: [warm(lb(45, 12)), lb(100, 10), lb(100, 9)] });
    expect(fill([], warmedLast)).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 10 } });
    expect(fill([a1(warm(lb(65, 5, 1)))], warmedLast)).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 10 } });
    expect(fill([a1(warm(lb(65, 5, 1)), lb(100, 10, 2))], warmedLast)).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 9 } });
  });

  it('treats a last time of only warm-ups as no history', () => {
    const onlyWarm = performance({ date: '2030-02-25', lift: 'bench-press', sets: [warm(lb(45, 12))] });
    expect(fill([], onlyWarm)).toEqual({ load: { kind: 'weight', amount: null, unit: 'lb' }, reps: { kind: 'total', reps: 8 } });
  });

  describe('after a swap', () => {
    const dumbbellRow = lift('dumbbell-row');
    const plannedLiftToday = performance({ slot: 'a2', lift: 'cable-row', sets: [lb(150, 10, 1)] });
    const ownLast = performance({ date: '2030-02-25', lift: 'dumbbell-row', sets: [kg(25, 12), kg(25, 11)] });

    it('uses the swapped lift\'s own history, as he typed it', () => {
      expect(fill([plannedLiftToday], ownLast, threeByTen, dumbbellRow)).toEqual({ load: kg(25, 12).load, reps: { kind: 'total', reps: 12 } });
    });

    it('stays blank with no history, never the old lift\'s weight from the slot', () => {
      expect(fill([plannedLiftToday], undefined, threeByTen, dumbbellRow)).toEqual({ load: { kind: 'weight', amount: null, unit: 'lb' }, reps: { kind: 'total', reps: 8 } });
    });

    it('ignores a last time from the old lift handed over by mistake', () => {
      const oldLift = performance({ date: '2030-02-25', lift: 'cable-row', sets: [lb(150, 10)] });
      expect(fill([], oldLift, threeByTen, dumbbellRow).load).toEqual({ kind: 'weight', amount: null, unit: 'lb' });
    });

    it('fills the next set from the swapped lift\'s set today', () => {
      const swappedToday = swappedA2(kg(30, 10, 2));
      expect(fill([plannedLiftToday, swappedToday], ownLast, threeByTen, dumbbellRow)).toEqual({ load: kg(30, 10).load, reps: { kind: 'total', reps: 11 } });
    });
  });

  it('reads history through an alias', () => {
    const book = liftBook([{ id: lift('squat'), name: 'Squat', aliases: [lift('back-squat')] }]);
    const old = performance({ date: '2030-02-25', lift: 'back-squat', sets: [lb(200, 5)] });
    expect(prefillSet({ lift: lift('squat'), book, target: threeByTen, today: [], last: old }).load).toEqual(lb(200, 5).load);
  });

  it('copies bodyweight and band loads, and blanks by the target with no history', () => {
    const pullUps = performance({ date: '2030-02-25', lift: 'bench-press', sets: [bw(8)] });
    expect(fill([], pullUps).load).toEqual({ kind: 'bodyweight' });
    const banded = performance({ date: '2030-02-25', lift: 'bench-press', sets: [band('green', 15)] });
    expect(fill([], banded).load).toEqual({ kind: 'band', label: 'green' });
    expect(fill([], undefined, target(3, 5, 8, { load: 'bodyweight' })).load).toEqual({ kind: 'bodyweight' });
    expect(fill([], undefined, target(3, 5, 8, { load: 'band' })).load).toEqual({ kind: 'band', label: '' });
  });

  it('asks for each side when a per-side target names no starting side', () => {
    expect(fill([], undefined, target(3, 8, 10, { perSide: 'either' })).reps).toEqual({ kind: 'sides', left: 8, right: 8 });
  });

  it('follows per-side reps, and blanks everything with no target or history', () => {
    const perSide = target(3, 8, 10, { perSide: 'left-first' });
    expect(fill([], undefined, perSide).reps).toEqual({ kind: 'sides', left: 8, right: 8 });
    const lastSides = performance({ date: '2030-02-25', lift: 'bench-press', sets: [sides(25, 10, 9)] });
    expect(fill([], lastSides, perSide).reps).toEqual({ kind: 'sides', left: 10, right: 9 });
    expect(prefillSet({ lift: benchPress, book: noCatalog, target: undefined, today: [], last: undefined })).toEqual({ load: { kind: 'weight', amount: null, unit: 'lb' }, reps: { kind: 'total', reps: null } });
  });
});

describe('sessionPhase and finishOf', () => {
  const hour = 3_600_000;

  const phaseOf = (doc: Session, now: number, performances: readonly Performance[] = []) => sessionPhase({ session: doc, performances }, ms(now));

  it('with no set, stays open for six hours from the start, then lapses', () => {
    const open = session({ startedAt: ms(T0) });
    expect(phaseOf(open, T0 + 6 * hour - 1)).toBe('open');
    expect(phaseOf(open, T0 + 6 * hour)).toBe('lapsed');
    expect(phaseOf(session({ startedAt: ms(T0), finishedAt: ms(T0 + hour) }), T0)).toBe('finished');
    expect(phaseOf(session({ source: 'notion' }), T0)).toBe('imported');
  });

  it('stays open for six hours from the last set, however long ago it started', () => {
    const long = session({ startedAt: ms(T0) });
    const late = [a1(lb(100, 8, 5 * 60))];
    expect(phaseOf(long, T0 + 6 * hour, late)).toBe('open');
    expect(phaseOf(long, T0 + 11 * hour - 1, late)).toBe('open');
    expect(phaseOf(long, T0 + 11 * hour, late)).toBe('lapsed');
  });

  it('agrees with finishOf on a long session, so the coach and the phone read it alike', () => {
    const long = session({ startedAt: ms(T0) });
    const late = [a1(lb(100, 8, 5 * 60))];
    expect(finishOf({ session: long, performances: late }, ms(T0 + 7 * hour))).toBeNull();
    expect(finishOf({ session: long, performances: late }, ms(T0 + 11 * hour))).toBe(minutes(5 * 60));
  });

  it('finishes a forgotten session at its last set, warm-ups included', () => {
    const forgotten = session({ startedAt: ms(T0) });
    const performances = [a1(lb(100, 8, 5), warm(lb(60, 5, 40))), a2(lb(120, 10, 20))];
    expect(finishOf({ session: forgotten, performances }, ms(T0 + hour))).toBeNull();
    expect(finishOf({ session: forgotten, performances }, ms(T0 + 7 * hour))).toBe(minutes(40));
    expect(finishOf({ session: forgotten, performances: [] }, ms(T0 + 7 * hour))).toBeNull();
    expect(finishOf({ session: session({ finishedAt: minutes(50) }), performances }, ms(T0))).toBe(minutes(50));
  });
});

describe('sessionWorkoutDraft', () => {
  const push = session();
  const run = (minutesLong: number, loggedAtMinute: number, id = WorkoutId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c')): Workout =>
    makeWorkout({ name: 'Run', minutes: minutesLong, source: { kind: 'met', activity: 'run_6', met: 9.3 } }, { id, date: push.date, kg: 70, loggedAt: minutes(loggedAtMinute) });

  it('runs from the first set, warm-up or not, to the finish', () => {
    const performances = [a1(warm(lb(45, 10, 5)), lb(100, 8, 15))];
    expect(sessionWorkoutDraft({ logs: { session: push, performances }, finishedAt: minutes(65), others: [] })).toEqual({
      name: 'Push',
      minutes: 60,
      source: { kind: 'met', activity: 'strength', met: 3.5 },
    });
  });

  it('takes out cardio logged inside the span and leaves cardio outside it', () => {
    const logs = { session: push, performances: [a1(lb(100, 8, 0))] };
    expect(sessionWorkoutDraft({ logs, finishedAt: minutes(60), others: [run(20, 30)] })?.minutes).toBe(40);
    expect(sessionWorkoutDraft({ logs, finishedAt: minutes(60), others: [run(20, -30), run(20, 90)] })?.minutes).toBe(60);
  });

  it('gives the same answer when finishing twice, leaving out its own first workout', () => {
    const logs = { session: push, performances: [a1(lb(100, 8, 0))] };
    const first = sessionWorkoutDraft({ logs, finishedAt: minutes(60), others: [] });
    const own = run(60, 60, sessionWorkoutId(push));
    expect(sessionWorkoutDraft({ logs, finishedAt: minutes(60), others: [own] })).toEqual(first);
  });

  it('is null with no timed set, as on a cardio-only day or an import', () => {
    expect(sessionWorkoutDraft({ logs: { session: push, performances: [] }, finishedAt: minutes(60), others: [] })).toBeNull();
    expect(sessionWorkoutDraft({ logs: { session: push, performances: [a1(lb(100, 8))] }, finishedAt: minutes(60), others: [] })).toBeNull();
  });

  it('never drops below a minute, and names an off-plan session plainly', () => {
    const { day: _day, ...offPlan } = push;
    expect(sessionWorkoutDraft({ logs: { session: offPlan, performances: [a1(lb(100, 8, 10))] }, finishedAt: minutes(10), others: [] })).toEqual({
      name: 'Strength training',
      minutes: 1,
      source: { kind: 'met', activity: 'strength', met: 3.5 },
    });
  });
});

describe('cardioDoneOn', () => {
  const today = session();
  const workout = (id = WorkoutId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c')): Workout => makeWorkout({ name: 'Run', minutes: 20, source: { kind: 'met', activity: 'run_6', met: 9.3 } }, { id, date: day('2030-03-04'), kg: 70, loggedAt: ms(T0) });

  it('counts another workout that date, but not the session\'s own', () => {
    expect(cardioDoneOn(today, [workout()])).toBe(true);
    expect(cardioDoneOn(today, [workout(sessionWorkoutId(today))])).toBe(false);
    expect(cardioDoneOn(today, [])).toBe(false);
  });

  it('counts any workout that date before the day has a session', () => {
    expect(cardioDoneOn(null, [workout()])).toBe(true);
    expect(cardioDoneOn(null, [])).toBe(false);
  });
});

describe('blockDone', () => {
  const warmUp = checklist('warm');
  const ride = cardio('ride');

  it('is a checklist tapped Done', () => {
    expect(blockDone(warmUp, { session: null, cardioDone: false })).toBe(false);
    expect(blockDone(warmUp, { session: session(), cardioDone: true })).toBe(false);
    expect(blockDone(warmUp, { session: session({ checked: [warmUp.id] }), cardioDone: false })).toBe(true);
  });

  it('is a cardio logged, with or without a session, or one an older build passed over', () => {
    expect(blockDone(ride, { session: null, cardioDone: false })).toBe(false);
    expect(blockDone(ride, { session: null, cardioDone: true })).toBe(true);
    expect(blockDone(ride, { session: session({ checked: [ride.id] }), cardioDone: false })).toBe(true);
  });
});

describe('sessionForDay', () => {
  const on = (key: string, extra: Partial<Session> = {}) => session({ day: { key: dayKey(key), label: key }, ...extra });

  it('finds the day\'s own, never another day\'s, an off-plan one or an import', () => {
    const mine = on('push');
    const { day: _day, ...offPlan } = on('push');
    expect(sessionForDay([on('pull'), offPlan, on('push', { source: 'notion' }), mine], dayKey('push'))).toBe(mine);
    expect(sessionForDay([on('pull'), offPlan, on('push', { source: 'notion' })], dayKey('push'))).toBeUndefined();
  });

  it('takes a finished one too, so a later set that date reopens it rather than making another', () => {
    const settled = on('push', { finishedAt: minutes(60) });
    expect(sessionForDay([settled], dayKey('push'))).toBe(settled);
  });

  it('settles on the newest of two, whichever order they read in', () => {
    const older = on('push', { startedAt: minutes(0) });
    const newer = on('push', { startedAt: minutes(5) });
    expect(sessionForDay([older, newer], dayKey('push'))).toBe(newer);
    expect(sessionForDay([newer, older], dayKey('push'))).toBe(newer);
  });
});

describe('afterSet', () => {
  const a = slotId('a1');

  it('changes nothing on an open session, so a set writes only its performance', () => {
    const open = session({ skips: [{ slotId: slotId('a2') }] });
    expect(afterSet(open, a)).toBe(open);
  });

  it('takes back a skip of that slot and leaves another\'s', () => {
    const skipped = session({ skips: [{ slotId: a }, { slotId: slotId('a2') }] });
    expect(afterSet(skipped, a).skips).toEqual([{ slotId: slotId('a2') }]);
  });

  it('reopens a settled session, keeping everything else on it', () => {
    const settled = session({ finishedAt: minutes(60), note: 'Invented note.' });
    const next = afterSet(settled, a);
    expect(next).not.toHaveProperty('finishedAt');
    expect(next).toEqual(reopened(settled));
    expect(next.note).toBe('Invented note.');
  });

  it('on an added exercise, only reopens a settled session and leaves every skip', () => {
    const skipped = session({ skips: [{ slotId: a }] });
    expect(afterSet(skipped, undefined)).toBe(skipped);
    const settled = session({ finishedAt: minutes(60), skips: [{ slotId: a }] });
    expect(afterSet(settled, undefined)).toEqual(reopened(settled));
  });
});

describe('trainedLately', () => {
  const hour = 3_600_000;
  const at = (hoursAgo: number) => performance({ lift: 'bench-press', sets: [{ ...lb(100, 8), at: ms(T0 - hoursAgo * hour) }] });

  it('holds for a set under three hours old, and not at three hours or for an imported set', () => {
    expect(trainedLately([at(2.9)], ms(T0))).toBe(true);
    expect(trainedLately([at(3)], ms(T0))).toBe(false);
    expect(trainedLately([performance({ lift: 'bench-press', sets: [lb(100, 8)] })], ms(T0))).toBe(false);
    expect(trainedLately([], ms(T0))).toBe(false);
  });
});

describe('exerciseLog', () => {
  const bench = slot('a1', 'bench-press', 3);
  const benchNow = { slot: bench, lift: { liftId: bench.liftId, label: bench.label } };
  const calves = { slot: null, lift: { liftId: lift('calf-raise'), label: 'Calf raise' } };
  const added = (...sets: SetLog[]) => performance({ lift: 'calf-raise', sets });

  it('fills a dot per working set, across a swap and in the order tapped', () => {
    const planned = performance({ slot: 'a1', lift: 'bench-press', sets: [warm(lb(45, 10, 1)), lb(100, 8, 2)] });
    const swapped = performance({ slot: 'a1', lift: 'machine-press', planned: 'bench-press', sets: [lb(120, 8, 3)] });
    const log = exerciseLog(benchNow, { session: session(), performances: [swapped, planned] });
    expect(log).toMatchObject({ done: 2, dots: 3, skipped: false });
    expect(log.sets.map((row) => `${row.performance.liftId}#${row.index}`)).toEqual(['bench-press#0', 'bench-press#1', 'machine-press#0']);
  });

  it('adds a dot for an extra set, and marks a skip', () => {
    const cableRow = slot('a2', 'cable-row', 2);
    expect(exerciseLog({ slot: cableRow, lift: { liftId: cableRow.liftId, label: cableRow.label } }, { session: session(), performances: [a2(lb(50, 8, 1), lb(50, 8, 2), lb(50, 8, 3))] })).toMatchObject({ done: 3, dots: 3 });
    expect(exerciseLog(benchNow, { session: session({ skips: [{ slotId: bench.id }] }), performances: [] }).skipped).toBe(true);
  });

  it('reads empty before the day has a session', () => {
    expect(exerciseLog(benchNow, { session: null, performances: [] })).toEqual({ done: 0, dots: 3, skipped: false, sets: [] });
  });

  it('counts this exercise alone, whatever else today holds', () => {
    expect(exerciseLog(benchNow, { session: session(), performances: [a2(lb(50, 8, 1), lb(50, 8, 2))] }).done).toBe(0);
  });

  it('gives an added exercise a filled dot per working set, and never a skip', () => {
    const log = exerciseLog(calves, { session: session({ skips: [{ slotId: bench.id }] }), performances: [added(warm(bw(15, 1)), bw(20, 2), bw(18, 3))] });
    expect(log).toMatchObject({ done: 2, dots: 2, skipped: false });
    expect(exerciseLog(calves, { session: null, performances: [] })).toEqual({ done: 0, dots: 0, skipped: false, sets: [] });
  });

  it('keeps an added exercise apart from a slot that did the same lift', () => {
    const inSlot = performance({ slot: 'a1', lift: 'calf-raise', planned: 'bench-press', sets: [bw(20, 1)] });
    expect(exerciseLog(calves, { session: session(), performances: [inSlot, added(bw(15, 2))] }).done).toBe(1);
  });
});

describe('addedOn', () => {
  it('lists the slot-less lifts in the order of their first set', () => {
    const calves = performance({ lift: 'calf-raise', label: 'Calf raise', sets: [bw(20, 9), bw(20, 12)] });
    const curls = performance({ lift: 'zottman-curl', label: 'Zottman curl', sets: [lb(20, 10, 3)] });
    expect(addedOn([calves, a1(lb(100, 8, 1)), curls])).toEqual([
      { liftId: lift('zottman-curl'), label: 'Zottman curl' },
      { liftId: lift('calf-raise'), label: 'Calf raise' },
    ]);
    expect(addedOn([a1(lb(100, 8, 1))])).toEqual([]);
  });
});

describe('liftsOnDay', () => {
  it('holds each slot\'s planned lift and the one in it now, and what he added', () => {
    const plan = { key: dayKey('push'), label: 'Push', minutes: undefined, blocks: [liftsBlock('pair', [slot('a1', 'bench-press', 3), slot('a2', 'cable-row', 3)]), checklist('warm')] };
    const liftOf = (one: Slot) => (one.id === 'a2' ? { liftId: lift('seal-row'), label: 'Seal row' } : { liftId: one.liftId, label: one.label });
    expect(liftsOnDay(plan, [{ liftId: lift('calf-raise'), label: 'Calf raise' }], liftOf).toSorted()).toEqual(['bench-press', 'cable-row', 'calf-raise', 'seal-row']);
  });
});

describe('isOn', () => {
  const row = slot('a2', 'cable-row', 2);

  it('holds a swap in a planned exercise\'s slot', () => {
    const exercise = { slot: row, lift: { liftId: row.liftId, label: 'Cable row' } };
    expect(isOn(exercise, swappedA2(lb(30, 8)))).toBe(true);
    expect(isOn(exercise, a1(lb(100, 8)))).toBe(false);
  });

  it('holds only slot-less rows of an added exercise\'s own lift', () => {
    const exercise = { slot: null, lift: { liftId: lift('cable-row'), label: 'Cable row' } };
    expect(isOn(exercise, performance({ lift: 'cable-row', sets: [lb(50, 8)] }))).toBe(true);
    expect(isOn(exercise, performance({ lift: 'seal-row', sets: [lb(50, 8)] }))).toBe(false);
    expect(isOn(exercise, a2(lb(50, 8)))).toBe(false);
  });
});

describe('setLogOf', () => {
  const entry = { load: { kind: 'weight' as const, amount: 85, unit: 'lb' as const }, reps: { kind: 'total' as const, reps: 12 }, warmup: false, note: '' };

  it('stores the tap, a warm-up flag and a trimmed note, and only those it was given', () => {
    expect(setLogOf(entry, minutes(1))).toEqual({ load: entry.load, reps: entry.reps, at: minutes(1) });
    expect(setLogOf({ ...entry, warmup: true, note: '  easy ' })).toEqual({ load: entry.load, reps: entry.reps, warmup: true, note: 'easy' });
  });

  it('is null while a number is blank or out of range, so Log set stays off', () => {
    expect(setLogOf({ ...entry, load: { kind: 'weight', amount: null, unit: 'lb' } })).toBeNull();
    expect(setLogOf({ ...entry, load: { kind: 'weight', amount: 0, unit: 'lb' } })).toBeNull();
    expect(setLogOf({ ...entry, reps: { kind: 'total', reps: null } })).toBeNull();
    expect(setLogOf({ ...entry, reps: { kind: 'total', reps: 2.5 } })).toBeNull();
    expect(setLogOf({ ...entry, reps: { kind: 'sides', left: 8, right: null } })).toBeNull();
    expect(setLogOf({ ...entry, load: { kind: 'band', label: '' } })).toBeNull();
  });

  it('accepts zero reps and every kind of load', () => {
    expect(setLogOf({ ...entry, reps: { kind: 'total', reps: 0 } })).not.toBeNull();
    expect(setLogOf({ ...entry, load: { kind: 'bodyweight' } })).not.toBeNull();
    expect(setLogOf({ ...entry, load: { kind: 'band', label: 'green' } })).not.toBeNull();
  });

  it('reads back what a logged set holds, so an edit starts from it', () => {
    const logged = setLogOf({ ...entry, warmup: true, note: 'easy' }, minutes(1));
    expect(logged === null ? null : entryOfSet(logged)).toEqual({ ...entry, warmup: true, note: 'easy' });
  });
});

describe('the steppers', () => {
  it('step a load by 2.5 lb or 1 kg, and minus past the last step is bodyweight', () => {
    expect(steppedLoad(85, 'lb', 1)).toBe(87.5);
    expect(steppedLoad(85, 'lb', -1)).toBe(82.5);
    expect(steppedLoad(20, 'kg', 1)).toBe(21);
    expect(steppedLoad(3.5, 'lb', -1)).toBe(1);
    expect(steppedLoad(2.5, 'lb', -1)).toBe('bodyweight');
    expect(steppedLoad(1, 'kg', -1)).toBe('bodyweight');
    expect(steppedLoad(null, 'lb', 1)).toBe(2.5);
    expect(steppedLoad(null, 'kg', -1)).toBe('bodyweight');
  });

  it('step reps by one, down to zero', () => {
    expect(steppedReps(8, 1)).toBe(9);
    expect(steppedReps(1, -1)).toBe(0);
    expect(steppedReps(0, -1)).toBe(0);
    expect(steppedReps(null, 1)).toBe(1);
  });

  it('order the sides as the target names, left first when it names none', () => {
    expect(sideOrder('left-first')).toEqual(['left', 'right']);
    expect(sideOrder('right-first')).toEqual(['right', 'left']);
    expect(sideOrder('either')).toEqual(['left', 'right']);
  });
});

describe('prefillSet and a warm-up in another unit', () => {
  it('keeps a blank load in the unit he warmed up in', () => {
    const warmedUp = performance({ lift: 'bench-press', sets: [warm(kg(20, 10, 1))] });
    expect(prefillSet({ lift: lift('bench-press'), book: noCatalog, target: target(3, 8, 12), today: [warmedUp], last: undefined }).load).toEqual({ kind: 'weight', amount: null, unit: 'kg' });
  });
});

describe('liftInSlot', () => {
  const row = slot('a2', 'cable-row', 2, { label: 'Cable row' });

  it('is the plan\'s lift until a set says otherwise', () => {
    expect(liftInSlot(row, [])).toEqual({ liftId: lift('cable-row'), label: 'Cable row' });
  });

  it('stays on the lift that took the newest set, and follows him back', () => {
    const planned = performance({ slot: 'a2', lift: 'cable-row', label: 'Cable row', sets: [lb(50, 8, 1)] });
    const swapped = performance({ slot: 'a2', lift: 'dumbbell-row', label: 'Dumbbell row', planned: 'cable-row', sets: [lb(30, 8, 2)] });
    expect(liftInSlot(row, [planned, swapped]).liftId).toBe(lift('dumbbell-row'));
    expect(liftInSlot(row, [{ ...planned, sets: [lb(50, 8, 1), lb(50, 8, 3)] }, swapped]).liftId).toBe(lift('cable-row'));
  });
});

describe('cueFor', () => {
  const press = slot('a1', 'bench-press', 3, { cue: 'Invented slot cue.', swaps: [{ liftId: lift('landmine-press'), label: 'Landmine press', cue: 'Invented swap cue.' }, { liftId: lift('machine-press'), label: 'Machine press' }] });

  it('is the slot\'s for its own lift, the swap\'s for a listed swap, and none otherwise', () => {
    expect(cueFor(press, lift('bench-press'))).toBe('Invented slot cue.');
    expect(cueFor(press, lift('landmine-press'))).toBe('Invented swap cue.');
    expect(cueFor(press, lift('machine-press'))).toBeUndefined();
    expect(cueFor(press, lift('zottman-press'))).toBeUndefined();
  });
});

describe('withSet', () => {
  const doc = session();
  const row = slot('a2', 'cable-row', 2, { label: 'Cable row', target: target(2, 8, 12) });
  const planned = { session: doc, exercise: { slot: row, lift: { liftId: row.liftId, label: row.label } } };
  const swap = { session: doc, exercise: { slot: row, lift: { liftId: lift('dumbbell-row'), label: 'Dumbbell row' } } };

  it('starts a performance holding the target by value', () => {
    expect(withSet(planned, undefined, lb(50, 8, 1))).toMatchObject({ sessionId: doc.id, date: doc.date, liftId: row.liftId, label: 'Cable row', slotId: row.id, target: row.target, sets: [lb(50, 8, 1)] });
    expect(withSet(planned, undefined, lb(50, 8, 1)).plannedLiftId).toBeUndefined();
  });

  it('marks a swap under the lift done, in its own document', () => {
    const swapped = withSet(swap, undefined, lb(30, 8, 2));
    expect(swapped).toMatchObject({ liftId: lift('dumbbell-row'), label: 'Dumbbell row', plannedLiftId: row.liftId, slotId: row.id });
    expect(swapped.id).not.toBe(withSet(planned, undefined, lb(50, 8, 1)).id);
  });

  it('appends to what is there, keeping what a newer app added', () => {
    const before = { ...withSet(planned, undefined, lb(50, 8, 1)), fromNewerApp: 1 };
    expect(withSet(planned, before, lb(50, 9, 2))).toMatchObject({ sets: [lb(50, 8, 1), lb(50, 9, 2)], fromNewerApp: 1 });
  });

  it('starts an added exercise with no slot, target or planned lift, as a performance that parses', () => {
    const added = withSet({ session: doc, exercise: { slot: null, lift: { liftId: lift('calf-raise'), label: 'Calf raise' } } }, undefined, bw(20, 1));
    expect(added.id).toBe(`pf:${doc.id}::calf-raise`);
    expect(added).toEqual({ id: added.id, sessionId: doc.id, date: doc.date, liftId: lift('calf-raise'), label: 'Calf raise', sets: [bw(20, 1)] });
    expect(Performance.safeParse(added).success).toBe(true);
  });
});

describe('withEditedSet', () => {
  const before = performance({ lift: 'bench-press', sets: [lb(100, 8, 1), lb(100, 7, 2)] });

  it('replaces one set and removes one', () => {
    expect(withEditedSet(before, 1, lb(95, 8, 2))?.sets).toEqual([lb(100, 8, 1), lb(95, 8, 2)]);
    expect(withEditedSet(before, 0, null)?.sets).toEqual([lb(100, 7, 2)]);
  });

  it('is null when the last set goes, so the proof goes with it', () => {
    expect(withEditedSet(performance({ lift: 'bench-press', sets: [lb(100, 8, 1)] }), 0, null)).toBeNull();
  });
});

describe('skips and ticks', () => {
  const a = slotId('a1');

  it('holds one skip per slot with its note, trimmed', () => {
    const once = withSkip(session(), a, ' no bench free ');
    expect(once.skips).toEqual([{ slotId: a, note: 'no bench free' }]);
    expect(withSkip(once, a, '').skips).toEqual([{ slotId: a }]);
  });

  it('takes a skip back, leaving no empty list', () => {
    const skipped = withSkip(withSkip(session(), a, ''), slotId('a2'), '');
    expect(withoutSkip(skipped, a).skips).toEqual([{ slotId: slotId('a2') }]);
    expect('skips' in withoutSkip(withSkip(session(), a, ''), a)).toBe(false);
  });

  it('ticks a block once', () => {
    expect(withChecked(withChecked(session(), blockId('warm')), blockId('warm')).checked).toEqual([blockId('warm')]);
  });
});

describe('leftEmpty', () => {
  it('is true only with nothing of its own', () => {
    expect(leftEmpty({ session: session(), performances: [] })).toBe(true);
    expect(leftEmpty({ session: session(), performances: [a1(warm(lb(45, 10, 1)))] })).toBe(false);
    expect(leftEmpty({ session: session({ note: 'Invented note.' }), performances: [] })).toBe(false);
    expect(leftEmpty({ session: session({ checked: [blockId('warm')] }), performances: [] })).toBe(false);
    expect(leftEmpty({ session: session({ skips: [{ slotId: slotId('a1') }] }), performances: [] })).toBe(false);
  });
});

describe('finishDocs', () => {
  const push = session();
  const logs = { session: push, performances: [a1(lb(100, 8, 0))] };

  it('sets the finish and writes a workout under the session\'s id, dated and named by the session', () => {
    const { session: done, workout } = finishDocs({ logs, finishedAt: minutes(50), others: [], kg: 80 });
    expect(done.finishedAt).toBe(minutes(50));
    expect(workout).toMatchObject({ id: sessionWorkoutId(push), date: push.date, name: 'Push', minutes: 50, kg: 80, loggedAt: minutes(50) });
    expect(workout?.kcal).toBe(Math.round((2.5 * 80 * 50) / 60));
  });

  it('writes no workout with no set', () => {
    expect(finishDocs({ logs: { session: push, performances: [] }, finishedAt: minutes(50), others: [], kg: 80 })).toMatchObject({ workout: null, session: { finishedAt: minutes(50) } });
  });

  it('writes no workout with no body weight', () => {
    expect(finishDocs({ logs, finishedAt: minutes(50), others: [], kg: undefined }).workout).toBeNull();
  });

  it('keeps a workout the schema can store, however long a forgotten session ran', () => {
    const { workout } = finishDocs({ logs, finishedAt: ms(minutes(0) + 3 * 86_400_000), others: [], kg: 80 });
    expect(workout?.minutes).toBe(1440);
  });
});
