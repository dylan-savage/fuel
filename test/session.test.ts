import { describe, expect, it } from 'vitest';
import { makeWorkout, type Workout } from '../src/domain/burn.js';
import { WorkoutId } from '../src/domain/ids.js';
import { liftBook, type Performance, type SetLog } from '../src/domain/lifts.js';
import { plannedDay, type Block, type PlannedDay } from '../src/domain/program.js';
import {
  TrainingNote,
  blockDone,
  cardFor,
  cardioDoneOn,
  cueFor,
  entryOfSet,
  finishDocs,
  finishOf,
  focusAfterSet,
  isExtra,
  leftEmpty,
  liftInSlot,
  nextUp,
  prefillSet,
  restClock,
  sessionPhase,
  sessionWorkoutDraft,
  sessionWorkoutId,
  setLogOf,
  sideOrder,
  setsProgress,
  slotLog,
  steppedLoad,
  steppedReps,
  swapChoices,
  withChecked,
  withEditedSet,
  withSet,
  withSkip,
  withoutSkip,
  type Next,
  type Session,
  type SessionLogs,
} from '../src/domain/session.js';
import { T0, band, blockId, bw, cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, slotId, target, warm } from './training.fixtures.js';

const noCatalog = liftBook([]);

/** A1 bench press for 3 sets, A2 cable row for 2, resting 90 seconds. */
const superset = liftsBlock('a', [slot('a1', 'bench-press', 3), slot('a2', 'cable-row', 2)], { restSeconds: 90 });
const planOf = (...blocks: Block[]): PlannedDay => {
  const plan = plannedDay(program('2030-03-04', [{ key: 'push', blocks }]), dayKey('push'), day('2030-03-04'));
  if (plan === undefined) throw new Error('no plan');
  return plan;
};
const logsOf = (performances: readonly Performance[], extra: Partial<SessionLogs> = {}): SessionLogs => ({ session: session(), performances, cardioDone: false, ...extra });

const a1 = (...sets: SetLog[]) => performance({ slot: 'a1', lift: 'bench-press', sets });
const a2 = (...sets: SetLog[]) => performance({ slot: 'a2', lift: 'cable-row', sets });
const swappedA2 = (...sets: SetLog[]) => performance({ slot: 'a2', lift: 'dumbbell-row', planned: 'cable-row', sets });

function where(next: Next): string {
  switch (next.kind) {
    case 'set':
      return `${next.step.slot.id}.${next.step.round}`;
    case 'checklist':
    case 'cardio':
      return `${next.kind}:${next.block.id}`;
    case 'done':
      return `done:${next.optionalLeft.map((b) => b.id).join()}`;
  }
}

describe('nextUp', () => {
  const plan = planOf(superset);
  const up = (performances: readonly Performance[], extra: Partial<SessionLogs> = {}) => where(nextUp(plan, logsOf(performances, extra)));
  const n = (count: number) => Array.from({ length: count }, () => lb(100, 8));

  it.each([
    [0, 0, 'a1.1'],
    [1, 0, 'a2.1'],
    [1, 1, 'a1.2'],
    [2, 1, 'a2.2'],
    [2, 2, 'a1.3'],
    [3, 2, 'done:'],
  ])('walks a 2-set slot out of the last of 3 rounds: %i and %i sets give %s', (first, second, expected) => {
    expect(up([a1(...n(first)), a2(...n(second))])).toBe(expected);
  });

  it('never counts a warm-up as a round', () => {
    expect(up([a1(warm(lb(45, 10)), warm(lb(65, 8)))])).toBe('a1.1');
    expect(up([a1(warm(lb(45, 10)), lb(100, 8))])).toBe('a2.1');
    expect(up([a1(lb(100, 8)), a2(warm(lb(30, 10)))])).toBe('a2.1');
  });

  it('counts sets across a swap mid-superset, which keeps the slot', () => {
    expect(up([a1(lb(100, 8)), swappedA2(lb(50, 10))])).toBe('a1.2');
    expect(up([a1(lb(100, 8), lb(100, 8)), a2(lb(120, 10)), swappedA2(lb(50, 10))])).toBe('a1.3');
    expect(up([a1(lb(100, 8), lb(100, 8), lb(100, 8)), a2(lb(120, 10)), swappedA2(lb(50, 10))])).toBe('done:');
  });

  it('passes over a skipped slot', () => {
    const skipA2 = { session: session({ skips: [{ slotId: slotId('a2') }] }) };
    expect(up([], skipA2)).toBe('a1.1');
    expect(up([a1(lb(100, 8))], skipA2)).toBe('a1.2');
    expect(up([a1(...n(3))], skipA2)).toBe('done:');
  });

  it('lets logging out of order move the first gap', () => {
    expect(up([a2(lb(120, 10))])).toBe('a1.1');
    expect(up([a1(...n(2))])).toBe('a2.1');
    expect(up([a1(...n(3)), a2(lb(120, 10))])).toBe('a2.2');
  });

  it('does not mistake an extra set for the next round elsewhere', () => {
    expect(up([a1(...n(5))])).toBe('a2.1');
  });

  it('walks checklist and cardio blocks in order and passes over a done one', () => {
    const warmUp = checklist('warm');
    const cardio: Block = { kind: 'cardio', id: blockId('zone') };
    const mixed = planOf(warmUp, superset, cardio);
    const done = [a1(...n(3)), a2(...n(2))];
    expect(where(nextUp(mixed, logsOf([])))).toBe('checklist:warm');
    expect(where(nextUp(mixed, logsOf([], { session: session({ checked: [warmUp.id] }) })))).toBe('a1.1');
    expect(where(nextUp(mixed, logsOf(done, { session: session({ checked: [warmUp.id] }) })))).toBe('cardio:zone');
    expect(where(nextUp(mixed, logsOf(done, { session: session({ checked: [warmUp.id] }), cardioDone: true })))).toBe('done:');
  });

  it('never walks into an optional block and lists what is left of them', () => {
    const extra = liftsBlock('abs', [slot('c1', 'crunch', 2)], { optional: true });
    const main = liftsBlock('main', [slot('m1', 'bench-press', 1)]);
    const withOptional = planOf(extra, main);
    expect(where(nextUp(withOptional, logsOf([])))).toBe('m1.1');
    const finished = logsOf([performance({ slot: 'm1', lift: 'bench-press', sets: [lb(100, 8)] })]);
    expect(where(nextUp(withOptional, finished))).toBe('done:abs');
    const allDone = logsOf([...finished.performances, performance({ slot: 'c1', lift: 'crunch', sets: [bw(20), bw(20)] })]);
    expect(where(nextUp(withOptional, allDone))).toBe('done:');
  });
});

describe('restClock', () => {
  const plan = planOf(superset);
  const rest = (performances: readonly Performance[], extra: Partial<SessionLogs> = {}) => restClock(plan, logsOf(performances, extra));

  it('rests from the tap after every straight set', () => {
    const straight = planOf(liftsBlock('s', [slot('a1', 'bench-press', 3)], { restSeconds: 120 }));
    expect(restClock(straight, logsOf([a1(lb(100, 8, 10))]))).toEqual({ endsAt: ms(minutes(10) + 120_000), seconds: 120 });
  });

  it('waits for the round in a superset', () => {
    expect(rest([a1(lb(100, 8, 1))])).toBeNull();
    expect(rest([a1(lb(100, 8, 1)), a2(lb(120, 10, 2))])).toEqual({ endsAt: ms(minutes(2) + 90_000), seconds: 90 });
    expect(rest([a1(lb(100, 8, 1), lb(100, 8, 5)), a2(lb(120, 10, 2))])).toBeNull();
  });

  it('rests after the last round, which the 2-set slot has left', () => {
    const third = [a1(lb(100, 8, 1), lb(100, 8, 5), lb(100, 8, 9)), a2(lb(120, 10, 2), lb(120, 10, 6))];
    expect(rest(third)?.endsAt).toBe(ms(minutes(9) + 90_000));
  });

  it('rests when logging out of order finishes the round', () => {
    expect(rest([a2(lb(120, 10, 1)), a1(lb(100, 8, 2))])?.endsAt).toBe(ms(minutes(2) + 90_000));
  });

  it('rests when the last slot of the round is skipped', () => {
    const skipA2 = { session: session({ skips: [{ slotId: slotId('a2') }] }) };
    expect(rest([a1(lb(100, 8, 1))], skipA2)?.endsAt).toBe(ms(minutes(1) + 90_000));
  });

  it('runs through a swap, which keeps the slot', () => {
    expect(rest([a1(lb(100, 8, 1)), swappedA2(lb(50, 10, 2))])?.endsAt).toBe(ms(minutes(2) + 90_000));
  });

  it('starts nothing for a warm-up, even right after a finished round', () => {
    expect(rest([a1(warm(lb(45, 10, 1)))])).toBeNull();
    expect(rest([a1(lb(100, 8, 1), warm(lb(60, 5, 3))), a2(lb(120, 10, 2))])).toBeNull();
  });

  it('has nothing to say with no timed set, no rest, or a set off the plan', () => {
    expect(rest([])).toBeNull();
    expect(rest([a1(lb(100, 8)), a2(lb(120, 10))])).toBeNull();
    const noRest = planOf(liftsBlock('s', [slot('a1', 'bench-press', 3)]));
    expect(restClock(noRest, logsOf([a1(lb(100, 8, 1))]))).toBeNull();
    expect(rest([performance({ lift: 'crunch', sets: [bw(20, 1)] })])).toBeNull();
  });
});

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
  const workoutOn = (date: string, id = WorkoutId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c')): Workout =>
    makeWorkout({ name: 'Run', minutes: 20, source: { kind: 'met', activity: 'run_6', met: 9.3 } }, { id, date: day(date), kg: 70, loggedAt: ms(T0) });

  it('counts another workout on the date, but not the session\'s own or another day\'s', () => {
    expect(cardioDoneOn(today, [workoutOn('2030-03-04')])).toBe(true);
    expect(cardioDoneOn(today, [workoutOn('2030-03-05')])).toBe(false);
    expect(cardioDoneOn(today, [workoutOn('2030-03-04', sessionWorkoutId(today))])).toBe(false);
  });
});

describe('TrainingNote', () => {
  it('holds a line of text for a date', () => {
    const note = { id: '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c', date: '2030-03-04', text: 'Left knee felt off.', at: T0 };
    expect(TrainingNote.safeParse(note).success).toBe(true);
    expect(TrainingNote.safeParse({ ...note, text: '' }).success).toBe(false);
    expect(TrainingNote.safeParse({ ...note, id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('cardFor', () => {
  const extras = liftsBlock('x', [slot('x1', 'reverse-crunch', 2), slot('x2', 'dead-bug', 2)], { optional: true });
  const warmUp = checklist('warm');
  const ride = cardio('ride', { optional: true });
  const day_ = planOf(warmUp, superset, extras, ride);
  const ticked = { session: session({ checked: [warmUp.id] }) };
  const onSlot = (id: string) => ({ kind: 'slot' as const, slotId: slotId(id) });
  const onBlock = (id: string) => ({ kind: 'block' as const, blockId: blockId(id) });

  it('follows nextUp with no tap', () => {
    expect(where(cardFor(day_, logsOf([], ticked), undefined))).toBe('a1.1');
    expect(where(cardFor(day_, logsOf([]), undefined))).toBe('checklist:warm');
  });

  it('jumps to any slot at its next round, out of order and into an optional block', () => {
    expect(where(cardFor(day_, logsOf([], ticked), onSlot('a2')))).toBe('a2.1');
    expect(where(cardFor(day_, logsOf([a2(lb(50, 8, 1))], ticked), onSlot('a2')))).toBe('a2.2');
    expect(where(cardFor(day_, logsOf([], ticked), onSlot('x1')))).toBe('x1.1');
  });

  it('runs past the prescription, which is what an extra set is', () => {
    const next = cardFor(day_, logsOf([a2(lb(50, 8, 1), lb(50, 8, 2))], ticked), onSlot('a2'));
    expect(where(next)).toBe('a2.3');
    expect(next.kind === 'set' && isExtra(next.step)).toBe(true);
    const asked = cardFor(day_, logsOf([a2(lb(50, 8, 1))], ticked), onSlot('a2'));
    expect(asked.kind === 'set' && isExtra(asked.step)).toBe(false);
  });

  it('never counts a warm-up toward the round it jumps to', () => {
    expect(where(cardFor(day_, logsOf([a1(warm(lb(45, 10, 1)))], ticked), onSlot('a1')))).toBe('a1.1');
  });

  it('jumps back into a slot he skipped', () => {
    const skipped = { session: session({ checked: [warmUp.id], skips: [{ slotId: slotId('a1') }] }) };
    expect(where(cardFor(day_, logsOf([], skipped), undefined))).toBe('a2.1');
    expect(where(cardFor(day_, logsOf([], skipped), onSlot('a1')))).toBe('a1.1');
  });

  it('keeps a jump into an optional block until its gaps are filled, then hands back', () => {
    const inExtras = logsOf([performance({ slot: 'x1', lift: 'reverse-crunch', sets: [bw(10, 1)] })], ticked);
    expect(where(cardFor(day_, inExtras, onBlock('x')))).toBe('x2.1');
    const filled = logsOf(
      [performance({ slot: 'x1', lift: 'reverse-crunch', sets: [bw(10, 1), bw(10, 2)] }), performance({ slot: 'x2', lift: 'dead-bug', sets: [bw(10, 3), bw(10, 4)] })],
      ticked,
    );
    expect(where(cardFor(day_, filled, onBlock('x')))).toBe('a1.1');
  });

  it('jumps to checklist and cardio blocks, and a done one hands back', () => {
    expect(where(cardFor(day_, logsOf([]), onBlock('ride')))).toBe('cardio:ride');
    expect(where(cardFor(day_, logsOf([], ticked), onBlock('warm')))).toBe('a1.1');
  });

  it('ignores a focus the plan no longer holds', () => {
    expect(where(cardFor(day_, logsOf([], ticked), onSlot('gone')))).toBe('a1.1');
    expect(where(cardFor(day_, logsOf([], ticked), onBlock('gone')))).toBe('a1.1');
  });

  it('stays in an optional block after a set and follows the plan after any other', () => {
    expect(focusAfterSet({ block: extras, slot: slot('x1', 'reverse-crunch', 2), round: 1, endsRound: false })).toEqual({ kind: 'block', blockId: blockId('x') });
    expect(focusAfterSet({ block: superset, slot: slot('a1', 'bench-press', 3), round: 1, endsRound: false })).toBeUndefined();
  });
});

describe('passing a cardio block', () => {
  const ride = cardio('ride');
  const plan = planOf(ride);

  it('moves the card on with no workout, and stays done', () => {
    const passed = logsOf([], { session: session({ checked: [ride.id] }) });
    expect(where(nextUp(plan, passed))).toBe('done:');
    expect(blockDone(ride, passed)).toBe(true);
    expect(blockDone(ride, logsOf([]))).toBe(false);
    expect(blockDone(ride, logsOf([], { cardioDone: true }))).toBe(true);
  });
});

describe('slotLog', () => {
  const bench = slot('a1', 'bench-press', 3);

  it('fills a dot per working set, across a swap and in the order tapped', () => {
    const planned = performance({ slot: 'a1', lift: 'bench-press', sets: [warm(lb(45, 10, 1)), lb(100, 8, 2)] });
    const swapped = performance({ slot: 'a1', lift: 'machine-press', planned: 'bench-press', sets: [lb(120, 8, 3)] });
    const log = slotLog(bench, { session: session(), performances: [swapped, planned] });
    expect(log).toMatchObject({ rounds: 2, dots: 3, skipped: false });
    expect(log.sets.map((row) => `${row.performance.liftId}#${row.index}`)).toEqual(['bench-press#0', 'bench-press#1', 'machine-press#0']);
  });

  it('adds a dot for an extra set, and marks a skip', () => {
    expect(slotLog(slot('a2', 'cable-row', 2), { session: session(), performances: [a2(lb(50, 8, 1), lb(50, 8, 2), lb(50, 8, 3))] })).toMatchObject({ rounds: 3, dots: 3 });
    expect(slotLog(bench, { session: session({ skips: [{ slotId: bench.id }] }), performances: [] }).skipped).toBe(true);
  });
});

describe('setsProgress', () => {
  const optional = liftsBlock('extra', [slot('e1', 'pallof-press', 2)], { optional: true });
  const day = planOf(superset, optional);

  it('counts the required sets, with no warm-up and no optional set', () => {
    expect(setsProgress(day, logsOf([]))).toEqual({ done: 0, total: 5 });
    expect(setsProgress(day, logsOf([a1(warm(lb(20, 10)), lb(50, 10)), performance({ slot: 'e1', lift: 'pallof-press', sets: [bw(10)] })]))).toEqual({ done: 1, total: 5 });
  });

  it('does not run past the end on an extra set', () => {
    expect(setsProgress(day, logsOf([a1(lb(50, 10), lb(50, 10), lb(50, 10), lb(50, 10)), a2(lb(50, 10), lb(50, 10))]))).toEqual({ done: 5, total: 5 });
  });

  it('counts a swap under its slot, and asks a skipped slot only for what it got', () => {
    const skipped = session({ skips: [{ slotId: slotId('a2') }] });
    expect(setsProgress(day, logsOf([swappedA2(lb(50, 10))]))).toEqual({ done: 1, total: 5 });
    expect(setsProgress(day, logsOf([a1(lb(50, 10)), swappedA2(lb(50, 10))], { session: skipped }))).toEqual({ done: 2, total: 4 });
  });

  it('is empty on a day with no required lifting', () => {
    expect(setsProgress(planOf(checklist('warm')), logsOf([]))).toEqual({ done: 0, total: 0 });
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
  it('step a load by 2.5 lb or 1 kg, stopping at one step and leaving a blank alone on minus', () => {
    expect(steppedLoad(85, 'lb', 1)).toBe(87.5);
    expect(steppedLoad(85, 'lb', -1)).toBe(82.5);
    expect(steppedLoad(20, 'kg', 1)).toBe(21);
    expect(steppedLoad(2.5, 'lb', -1)).toBe(2.5);
    expect(steppedLoad(1, 'kg', -1)).toBe(1);
    expect(steppedLoad(null, 'lb', 1)).toBe(2.5);
    expect(steppedLoad(null, 'kg', -1)).toBeNull();
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
  const planned = { session: doc, slot: row, lift: { liftId: row.liftId, label: row.label } };
  const swap = { session: doc, slot: row, lift: { liftId: lift('dumbbell-row'), label: 'Dumbbell row' } };

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

describe('swapChoices', () => {
  const press = slot('a1', 'bench-press', 3, { label: 'Bench press', swaps: [{ liftId: lift('landmine-press'), label: 'Landmine press' }, { liftId: lift('machine-press'), label: 'Machine press' }] });
  const lifts = [
    { id: lift('bench-press'), name: 'Bench press', aliases: [] },
    { id: lift('landmine-press'), name: 'Landmine press', aliases: [] },
    { id: lift('machine-press'), name: 'Machine press', aliases: [] },
    { id: lift('pin-press'), name: 'Pin press', aliases: [lift('rack-press')] },
    { id: lift('seal-row'), name: 'Seal row', aliases: [] },
  ];
  const choose = (query: string, current = press.liftId) => swapChoices({ slot: press, lifts, current, query });
  const ids = (choices: readonly { readonly liftId: string }[]) => choices.map((c) => c.liftId);

  it('offers the listed swaps first, and no catalog until a search', () => {
    expect(ids(choose('').listed)).toEqual(['landmine-press', 'machine-press']);
    expect(choose('')).toMatchObject({ catalog: [], typed: null });
  });

  it('offers the plan\'s lift back once he has left it, and not the one he is on', () => {
    expect(ids(choose('', lift('landmine-press')).listed)).toEqual(['bench-press', 'machine-press']);
  });

  it('searches the catalog by name without repeating a listed lift or the current one', () => {
    expect(ids(choose('press').catalog)).toEqual(['pin-press']);
    expect(ids(choose('SEAL').catalog)).toEqual(['seal-row']);
  });

  it('finds a catalog lift through its alias, so an old name lands on the same history', () => {
    const found = choose('rack press');
    expect(ids(found.catalog)).toEqual(['pin-press']);
    expect(found.typed).toBeNull();
  });

  it('turns an unknown name into a new lift through its slug, keeping the words as typed', () => {
    expect(choose(' Zottman curl (slow) ').typed).toEqual({ liftId: lift('zottman-curl'), label: 'Zottman curl (slow)' });
  });

  it('offers nothing to type when the name has nothing to slug or the catalog knows it', () => {
    expect(choose('!!!').typed).toBeNull();
    expect(choose('Seal row').typed).toBeNull();
    expect(choose('Bench press').typed).toBeNull();
  });
});

describe('leftEmpty', () => {
  it('is true only with nothing done at all', () => {
    expect(leftEmpty(logsOf([]))).toBe(true);
    expect(leftEmpty(logsOf([a1(warm(lb(45, 10, 1)))]))).toBe(false);
    expect(leftEmpty(logsOf([], { cardioDone: true }))).toBe(false);
    expect(leftEmpty(logsOf([], { session: session({ note: 'Invented note.' }) }))).toBe(false);
    expect(leftEmpty(logsOf([], { session: session({ checked: [blockId('warm')] }) }))).toBe(false);
    expect(leftEmpty(logsOf([], { session: session({ skips: [{ slotId: slotId('a1') }] }) }))).toBe(false);
  });
});

describe('finishDocs', () => {
  const push = session();
  const logs = { session: push, performances: [a1(lb(100, 8, 0))] };

  it('sets the finish and writes a workout under the session\'s id, dated and named by the session', () => {
    const { session: done, workout, diary } = finishDocs({ logs, finishedAt: minutes(50), others: [], kg: 80 });
    expect(diary).toBe('added');
    expect(done.finishedAt).toBe(minutes(50));
    expect(workout).toMatchObject({ id: sessionWorkoutId(push), date: push.date, name: 'Push', minutes: 50, kg: 80, loggedAt: minutes(50) });
    expect(workout?.kcal).toBe(Math.round((2.5 * 80 * 50) / 60));
  });

  it('writes no workout with no set, and says so', () => {
    expect(finishDocs({ logs: { session: push, performances: [] }, finishedAt: minutes(50), others: [], kg: 80 })).toMatchObject({ workout: null, diary: 'no-sets', session: { finishedAt: minutes(50) } });
  });

  it('writes no workout with no body weight, and says so', () => {
    expect(finishDocs({ logs, finishedAt: minutes(50), others: [], kg: undefined })).toMatchObject({ workout: null, diary: 'no-weight' });
  });

  it('keeps a workout the schema can store, however long a forgotten session ran', () => {
    const { workout } = finishDocs({ logs, finishedAt: ms(minutes(0) + 3 * 86_400_000), others: [], kg: 80 });
    expect(workout?.minutes).toBe(1440);
  });
});
