import { describe, expect, it } from 'vitest';
import { makeWorkout, type Workout } from '../src/domain/burn.js';
import { WorkoutId } from '../src/domain/ids.js';
import { liftBook, type Performance, type SetLog } from '../src/domain/lifts.js';
import { plannedDay, type Block, type PlannedDay } from '../src/domain/program.js';
import { TrainingNote, cardioDoneOn, finishOf, nextUp, prefillSet, restClock, sessionPhase, sessionWorkoutDraft, sessionWorkoutId, type Next, type SessionLogs } from '../src/domain/session.js';
import { T0, band, blockId, bw, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, slotId, target, warm } from './training.fixtures.js';

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

  it('falls to last time\'s last load and the bottom of the range past its sets', () => {
    const short = performance({ date: '2030-02-25', lift: 'bench-press', sets: [lb(100, 10)] });
    expect(prefillSet({ lift: benchPress, book: noCatalog, target: threeByTen, today: [], last: short }).load).toEqual(lb(100, 10).load);
    const pastEnd = fill([a1(lb(100, 10, 1), lb(100, 10, 2), lb(100, 10, 3), lb(100, 10, 4))], lastTime);
    expect(pastEnd).toEqual({ load: lb(100, 10).load, reps: { kind: 'total', reps: 8 } });
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

  it('stays open for six hours from the start, then lapses', () => {
    const open = session({ startedAt: ms(T0) });
    expect(sessionPhase(open, ms(T0 + 6 * hour - 1))).toBe('open');
    expect(sessionPhase(open, ms(T0 + 6 * hour))).toBe('lapsed');
    expect(sessionPhase(session({ startedAt: ms(T0), finishedAt: ms(T0 + hour) }), ms(T0))).toBe('finished');
    expect(sessionPhase(session({ source: 'notion' }), ms(T0))).toBe('imported');
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
