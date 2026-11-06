/** The day's writes over a real replica: one tap, one commit, one undo, and what the views then read. */
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntents } from '../src/client/intents.js';
import { openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { dayScreenView, dayView, trainedRecentlyView, weekView } from '../src/client/views.js';
import { metDraft } from '../src/domain/burn.js';
import type { GoalDraft } from '../src/domain/goals.js';
import { addDays, type Millis } from '../src/domain/ids.js';
import { performanceId } from '../src/domain/lifts.js';
import type { Slot } from '../src/domain/program.js';
import { sessionWorkoutId, type DayRef, type Session, type SetEntry } from '../src/domain/session.js';
import { T0, blockId, cardio, checklist, day, dayKey, lift, liftsBlock, ms, program, session, slot, target } from './training.fixtures.js';

const TODAY = day('2030-03-06');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const bench = slot('a1', 'bench-press', 3, { label: 'Bench press', target: target(3, 8, 12) });
const row = slot('a2', 'cable-row', 2, { label: 'Cable row', target: target(2, 8, 12) });
const warmUp = checklist('warm');
const ride = cardio('ride');
const push = { key: 'push', label: 'Push', weekday: 3, blocks: [warmUp, liftsBlock('pair', [bench, row], { restSeconds: 90 }), ride] };
const pull = { key: 'pull', label: 'Pull', weekday: 4, blocks: [liftsBlock('main', [slot('b1', 'seal-row', 3, { label: 'Seal row' })])] };
const version = program('2030-03-04', [push, pull]);
const PUSH: DayRef = { key: dayKey('push'), date: TODAY };

const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function setup() {
  const { replica, port } = await openReplica({ name: 'session-intents', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  let now = T0;
  const intents = createIntents(replica, { now: () => ms(now), newId: randomUUID });
  await replica.commit([{ op: 'put', kind: 'program', doc: version }]);
  return {
    replica,
    port,
    intents,
    later: (ms_: number) => {
      now += ms_;
    },
    at: (): Millis => ms(now),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const lbs = (amount: number, reps: number): SetEntry => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'total', reps }, warmup: false, note: '' });
const planned = (one: Slot) => ({ slot: one, lift: { liftId: one.liftId, label: one.label } });
const benchOn = (date = TODAY) => ({ day: { key: dayKey('push'), date }, exercise: planned(bench) });
const rowOn = (date = TODAY) => ({ day: { key: dayKey('push'), date }, exercise: planned(row) });
const benchId = (doc: Session) => performanceId(doc.id, bench.id, bench.liftId);

async function pendingOps(port: SyncPort) {
  return (await port.nextBatch(100)).mutations.map((m) => `${m.op} ${m.kind}`);
}

/** Today's only session for the day. */
async function sessionOf({ replica }: Pick<Setup, 'replica'>, date = TODAY): Promise<Session> {
  const [doc, ...rest] = await replica.read.onDate('session', date);
  if (doc === undefined || rest.length > 0) throw new Error(`expected one session on ${date}`);
  return doc;
}

/** A day with one set logged, and its session. */
async function logged(s: Setup): Promise<Session> {
  await s.intents.logSet(benchOn(), lbs(100, 8));
  return sessionOf(s);
}

async function sets({ replica }: Pick<Setup, 'replica'>, doc: Session) {
  return (await replica.read.get('performance', benchId(doc)))?.sets.map((set) => (set.reps.kind === 'total' ? set.reps.reps : null));
}

const doneDays = async ({ replica }: Pick<Setup, 'replica'>) => (await weekView(replica.read, TODAY))?.days.filter((d) => d.doneOn !== null).map((d) => d.plan.key);

describe('the lazy session', () => {
  it('writes nothing for reading a day', async () => {
    const s = await setup();
    const before = await pendingOps(s.port);
    await dayScreenView(s.replica.read, PUSH);
    await weekView(s.replica.read, TODAY);
    expect(await pendingOps(s.port)).toEqual(before);
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('is made by the first set, in its commit, pinned to the version in effect', async () => {
    const s = await setup();
    const before = (await pendingOps(s.port)).length;
    await s.intents.logSet(benchOn(), lbs(100, 8));
    expect((await pendingOps(s.port)).slice(before).toSorted()).toEqual(['put performance', 'put session']);
    expect(await sessionOf(s)).toMatchObject({ date: TODAY, day: { key: 'push', label: 'Push' }, programId: version.id, startedAt: s.at() });
  });

  it.each([
    ['a skip', (s: Setup) => s.intents.skipSlot(PUSH, row.id, 'Invented reason.'), { skips: [{ slotId: row.id, note: 'Invented reason.' }] }],
    ['a note', (s: Setup) => s.intents.noteSession(PUSH, ' Invented note. '), { note: 'Invented note.' }],
    ['a tick', (s: Setup) => s.intents.checkBlock(PUSH, warmUp.id), { checked: [warmUp.id] }],
  ])('is made by %s too, and its undo takes it away', async (_name, write, holds) => {
    const s = await setup();
    const undo = await write(s);
    expect(await sessionOf(s)).toMatchObject({ programId: version.id, startedAt: s.at(), ...holds });
    await undo();
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('is not made by a blank note, which has nothing to hold', async () => {
    const s = await setup();
    await s.intents.noteSession(PUSH, '   ');
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('is reused by every later write that date, one session per day per date', async () => {
    const s = await setup();
    const doc = await logged(s);
    s.later(MINUTE);
    await s.intents.logSet(rowOn(), lbs(50, 10));
    await s.intents.logSet(benchOn(), lbs(100, 8));
    await s.intents.skipSlot(PUSH, row.id, '');
    await s.intents.noteSession(PUSH, 'Invented note.');
    await s.intents.checkBlock(PUSH, warmUp.id);
    expect((await sessionOf(s)).id).toBe(doc.id);
    expect(await sets(s, doc)).toEqual([8, 8]);
  });

  it('makes one on a double tap, losing neither set', async () => {
    const s = await setup();
    await Promise.all([s.intents.logSet(benchOn(), lbs(100, 8)), s.intents.logSet(benchOn(), lbs(100, 7))]);
    expect(await sets(s, await sessionOf(s))).toEqual([8, 7]);
  });

  it('gives each day its own, and another date a new one', async () => {
    const s = await setup();
    const first = await logged(s);
    await s.intents.logSet({ day: { key: dayKey('pull'), date: TODAY }, exercise: planned(slot('b1', 'seal-row', 3, { label: 'Seal row' })) }, lbs(70, 8));
    expect((await s.replica.read.onDate('session', TODAY)).map((doc) => doc.day?.key).toSorted()).toEqual(['pull', 'push']);

    const tomorrow = addDays(TODAY, 1);
    await s.intents.logSet(benchOn(tomorrow), lbs(105, 8));
    const next = await sessionOf(s, tomorrow);
    expect(next.id).not.toBe(first.id);
    expect((await s.replica.read.get('performance', benchId(next)))?.date).toBe(tomorrow);
  });

  it('pins a newer version on a later date, while today keeps what it pinned', async () => {
    const s = await setup();
    await logged(s);
    const renamed = program('2030-03-06', [{ ...push, label: 'Push, renamed' }, pull]);
    await s.replica.commit([{ op: 'put', kind: 'program', doc: renamed }]);
    expect((await dayScreenView(s.replica.read, PUSH))?.plan.label).toBe('Push');
    await s.intents.logSet(rowOn(), lbs(50, 10));
    expect((await sessionOf(s)).programId).toBe(version.id);

    const tomorrow = addDays(TODAY, 1);
    await s.intents.logSet(benchOn(tomorrow), lbs(105, 8));
    expect((await sessionOf(s, tomorrow)).programId).toBe(renamed.id);
  });

  it('writes nothing for a day the plan does not hold', async () => {
    const s = await setup();
    const elsewhere = { key: dayKey('legs'), date: TODAY };
    expect(await s.intents.logSet({ ...benchOn(), day: elsewhere }, lbs(100, 8))).toBeNull();
    await s.intents.checkBlock(elsewhere, warmUp.id);
    expect(await s.intents.logSet(benchOn(day('2030-03-01')), lbs(100, 8))).toBeNull();
    expect(await s.replica.read.all('session')).toEqual([]);
    expect(await s.replica.read.all('performance')).toEqual([]);
  });

  it('never writes into an import', async () => {
    const s = await setup();
    const imported = session({ date: TODAY, day: { key: dayKey('push'), label: 'Push' }, source: 'notion', startedAt: undefined });
    await s.replica.commit([{ op: 'put', kind: 'session', doc: imported }]);
    await s.intents.logSet(benchOn(), lbs(100, 8));
    const mine = (await s.replica.read.onDate('session', TODAY)).filter((doc) => doc.source !== 'notion');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(imported.id);
  });
});

describe('a day being done', () => {
  it('follows its sets, and undoing the only one makes it not done', async () => {
    const s = await setup();
    expect(await doneDays(s)).toEqual([]);
    const undo = await s.intents.logSet(benchOn(), lbs(100, 8));
    expect(await doneDays(s)).toEqual(['push']);
    await undo?.();
    expect(await doneDays(s)).toEqual([]);
    expect(await s.replica.read.all('session')).toEqual([]);
    expect(await s.replica.read.all('performance')).toEqual([]);
  });

  it('is not done by a warm-up, a tick, a skip or a note', async () => {
    const s = await setup();
    await s.intents.logSet(benchOn(), { ...lbs(45, 10), warmup: true });
    await s.intents.checkBlock(PUSH, warmUp.id);
    await s.intents.skipSlot(PUSH, row.id, '');
    await s.intents.noteSession(PUSH, 'Invented note.');
    expect(await doneDays(s)).toEqual([]);
  });

  it('is not done once its only set is deleted, and the emptied session goes at the next settle', async () => {
    const s = await setup();
    const doc = await logged(s);
    await s.intents.editSet({ performanceId: benchId(doc), index: 0 }, null);
    expect(await doneDays(s)).toEqual([]);
    expect((await sessionOf(s)).id).toBe(doc.id);
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect(await s.replica.read.all('session')).toEqual([]);
  });
});

describe('logSet', () => {
  it('stores the tap, and a later set writes one document', async () => {
    const s = await setup();
    const doc = await logged(s);
    const before = (await pendingOps(s.port)).length;
    s.later(MINUTE);
    await s.intents.logSet(benchOn(), lbs(100, 7));
    expect((await pendingOps(s.port)).slice(before)).toEqual(['put performance']);
    expect(await s.replica.read.get('performance', benchId(doc))).toMatchObject({ sessionId: doc.id, date: TODAY, target: bench.target, sets: [{ load: { amount: 100 }, reps: { reps: 8 } }, { reps: { reps: 7 }, at: s.at() }] });
  });

  it('undoes one set at a time, and the first takes the performance and the session with it', async () => {
    const s = await setup();
    const first = await s.intents.logSet(benchOn(), lbs(100, 8));
    const doc = await sessionOf(s);
    const second = await s.intents.logSet(benchOn(), lbs(100, 7));
    expect(await sets(s, doc)).toEqual([8, 7]);
    await second?.();
    expect(await sets(s, doc)).toEqual([8]);
    expect((await sessionOf(s)).id).toBe(doc.id);
    await first?.();
    expect(await sets(s, doc)).toBeUndefined();
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('writes nothing while the entry is incomplete', async () => {
    const s = await setup();
    expect(await s.intents.logSet(benchOn(), { ...lbs(100, 8), load: { kind: 'weight', amount: null, unit: 'lb' } })).toBeNull();
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('logs an added exercise as one slot-less performance, makes the session, and undo takes both', async () => {
    const s = await setup();
    const calves = { day: PUSH, exercise: { slot: null, lift: { liftId: lift('calf-raise'), label: 'Calf raise' } } };
    const first = await s.intents.logSet(calves, lbs(45, 15));
    const doc = await sessionOf(s);
    await s.intents.logSet(calves, lbs(45, 12));
    const stored = await s.replica.read.performancesOfSession(doc.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: performanceId(doc.id, undefined, lift('calf-raise')), liftId: 'calf-raise', label: 'Calf raise', sets: [{ reps: { reps: 15 } }, { reps: { reps: 12 } }] });
    expect(stored[0]).not.toHaveProperty('slotId');
    expect(stored[0]).not.toHaveProperty('target');
    expect((await dayScreenView(s.replica.read, PUSH))?.added).toEqual([{ liftId: lift('calf-raise'), label: 'Calf raise' }]);

    await s.intents.editSet({ performanceId: performanceId(doc.id, undefined, lift('calf-raise')), index: 1 }, null);
    await first?.();
    expect(await s.replica.read.all('performance')).toEqual([]);
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('takes a skip back on a set in that slot, and undo puts it back', async () => {
    const s = await setup();
    await s.intents.skipSlot(PUSH, bench.id, 'Invented note.');
    const undo = await s.intents.logSet(benchOn(), lbs(100, 8));
    expect((await sessionOf(s)).skips).toBeUndefined();
    await undo?.();
    expect((await sessionOf(s)).skips).toEqual([{ slotId: bench.id, note: 'Invented note.' }]);
  });
});

describe('editSet', () => {
  it('changes a set and keeps its tap, its place and what a newer app added', async () => {
    const s = await setup();
    const doc = await logged(s);
    const before = await s.replica.read.get('performance', benchId(doc));
    const tap = before?.sets[0]?.at;
    if (before === undefined) throw new Error('no performance');
    await s.replica.commit([{ op: 'put', kind: 'performance', doc: { ...before, sets: before.sets.map((set) => ({ ...set, fromNewerApp: 1 })) } }]);
    s.later(MINUTE);
    const undo = await s.intents.editSet({ performanceId: before.id, index: 0 }, lbs(105, 9));
    expect((await s.replica.read.get('performance', before.id))?.sets).toEqual([{ load: { kind: 'weight', amount: 105, unit: 'lb' }, reps: { kind: 'total', reps: 9 }, at: tap, fromNewerApp: 1 }]);
    await undo();
    expect((await s.replica.read.get('performance', before.id))?.sets[0]?.load).toEqual({ kind: 'weight', amount: 100, unit: 'lb' });
  });

  it('deletes one set, and the last takes the performance with it, and undo restores each', async () => {
    const s = await setup();
    const doc = await logged(s);
    await s.intents.logSet(benchOn(), lbs(100, 7));
    const id = benchId(doc);
    const first = await s.intents.editSet({ performanceId: id, index: 0 }, null);
    expect(await sets(s, doc)).toEqual([7]);
    const last = await s.intents.editSet({ performanceId: id, index: 0 }, null);
    expect(await sets(s, doc)).toBeUndefined();
    await last();
    expect(await sets(s, doc)).toEqual([7]);
    await first();
    expect(await sets(s, doc)).toEqual([8, 7]);
  });

  it('refuses an incomplete edit and a set that is gone', async () => {
    const s = await setup();
    const doc = await logged(s);
    await s.intents.editSet({ performanceId: benchId(doc), index: 0 }, { ...lbs(100, 8), reps: { kind: 'total', reps: null } });
    await s.intents.editSet({ performanceId: benchId(doc), index: 5 }, lbs(1, 1));
    expect(await sets(s, doc)).toEqual([8]);
  });
});

describe('notes, skips and ticks', () => {
  it('notes an exercise and the day, blank removes, and undo restores', async () => {
    const s = await setup();
    const doc = await logged(s);
    await s.intents.noteExercise(benchId(doc), ' Invented note. ');
    expect((await s.replica.read.get('performance', benchId(doc)))?.note).toBe('Invented note.');
    const undoBlank = await s.intents.noteExercise(benchId(doc), '  ');
    expect(await s.replica.read.get('performance', benchId(doc))).not.toHaveProperty('note');
    await undoBlank();
    expect((await s.replica.read.get('performance', benchId(doc)))?.note).toBe('Invented note.');

    const undoDay = await s.intents.noteSession(PUSH, 'Invented session note.');
    expect((await sessionOf(s)).note).toBe('Invented session note.');
    await undoDay();
    expect(await sessionOf(s)).not.toHaveProperty('note');
  });

  it('skips a slot on a session already there, and undo keeps the session', async () => {
    const s = await setup();
    const doc = await logged(s);
    const undo = await s.intents.skipSlot(PUSH, row.id, 'Invented reason.');
    expect((await sessionOf(s)).skips).toEqual([{ slotId: row.id, note: 'Invented reason.' }]);
    await undo();
    expect((await sessionOf(s)).skips).toBeUndefined();
    expect((await sessionOf(s)).id).toBe(doc.id);
  });

  it('ticks a block once, and undo keeps the session', async () => {
    const s = await setup();
    await logged(s);
    const undo = await s.intents.checkBlock(PUSH, warmUp.id);
    await s.intents.checkBlock(PUSH, warmUp.id);
    expect((await sessionOf(s)).checked).toEqual([blockId('warm')]);
    await undo();
    expect((await sessionOf(s)).checked).toBeUndefined();
  });

  it('writes a loose line to the coach, and undo removes it', async () => {
    const s = await setup();
    const undo = await s.intents.tellCoach(' Invented line. ', TODAY);
    expect(await s.replica.read.all('trainingNote')).toMatchObject([{ date: TODAY, text: 'Invented line.', at: s.at() }]);
    await undo();
    expect(await s.replica.read.all('trainingNote')).toEqual([]);
  });
});

describe('cardio', () => {
  it('writes a workout and no session, and answers on the day', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    expect((await dayScreenView(s.replica.read, PUSH))?.cardioDone).toBe(false);
    await s.intents.logWorkout(metDraft('walk_3', 20), TODAY);
    expect(await dayScreenView(s.replica.read, PUSH)).toMatchObject({ session: null, cardioDone: true });
    expect(await s.replica.read.all('session')).toEqual([]);
  });

  it('makes a day with no sets done when logged from that day, and undo takes both back', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const undo = await s.intents.logDayCardio(PUSH, metDraft('walk_3', 20));
    const [held] = await s.replica.read.all('session');
    expect(held?.date).toBe(TODAY);
    expect(held?.finishedAt).toBeDefined();
    expect(await s.replica.read.all('workout')).toHaveLength(1);
    await undo?.();
    expect(await s.replica.read.all('session')).toEqual([]);
    expect(await s.replica.read.all('workout')).toEqual([]);
  });

  it('leaves a day with sets open, so settle still times them', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    await logged(s);
    await s.intents.logDayCardio(PUSH, metDraft('walk_3', 20));
    const [held] = await s.replica.read.all('session');
    expect(held?.finishedAt).toBeUndefined();
    expect(await s.replica.read.all('workout')).toHaveLength(1);
  });

  it('is not satisfied by the session\'s own workout', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    await logged(s);
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect((await s.replica.read.all('workout')).length).toBe(1);
    expect((await dayScreenView(s.replica.read, PUSH))?.cardioDone).toBe(false);
  });
});

describe('settleLapsed', () => {
  it('finishes an idle session at its last set, once, with its workout', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const doc = await logged(s);
    s.later(10 * MINUTE);
    await s.intents.logSet(benchOn(), lbs(100, 8));
    const lastTap = s.at();
    s.later(6 * HOUR - 1);
    await s.intents.settleLapsed();
    expect((await sessionOf(s)).finishedAt).toBeUndefined();
    s.later(1);

    await s.intents.settleLapsed();
    expect((await sessionOf(s)).finishedAt).toBe(lastTap);
    expect((await s.replica.read.all('workout')).map((w) => [w.id, w.name, w.date, w.minutes, w.loggedAt])).toEqual([[sessionWorkoutId(doc), 'Push', TODAY, 10, lastTap]]);

    const pending = await s.replica.read.pendingCount();
    await s.intents.settleLapsed();
    expect(await s.replica.read.pendingCount()).toBe(pending);
  });

  it('keeps the session\'s date on a workout settled past midnight', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    await logged(s);
    s.later(24 * HOUR);
    await s.intents.settleLapsed();
    expect((await s.replica.read.all('workout')).map((w) => w.date)).toEqual([TODAY]);
  });

  it('finishes with no workout when no body weight is known', async () => {
    const s = await setup();
    await logged(s);
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect((await sessionOf(s)).finishedAt).toBeDefined();
    expect(await s.replica.read.all('workout')).toEqual([]);
  });

  it('removes an idle session with nothing in it, a same-day cardio or not', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    await s.intents.logWorkout(metDraft('walk_3', 20), TODAY);
    await s.replica.commit([{ op: 'put', kind: 'session', doc: session({ date: TODAY, startedAt: s.at() }) }]);
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect(await s.replica.read.all('session')).toEqual([]);
    expect(await s.replica.read.all('workout')).toHaveLength(1);
  });

  it('leaves one with a tick or note but no timed set, which has no time to finish at', async () => {
    const s = await setup();
    await s.intents.checkBlock(PUSH, warmUp.id);
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect(await sessionOf(s)).toMatchObject({ checked: [warmUp.id] });
    expect((await sessionOf(s)).finishedAt).toBeUndefined();
  });

  it('leaves an open session, a finished one and an import alone, and writes nothing', async () => {
    const s = await setup();
    const docs = [session({ date: TODAY, source: 'notion', startedAt: ms(T0 - 100 * HOUR) }), session({ date: TODAY, startedAt: ms(T0 - 100 * HOUR), finishedAt: ms(T0 - 99 * HOUR) }), session({ date: TODAY, startedAt: ms(T0) })];
    await s.replica.commit(docs.map((doc) => ({ op: 'put', kind: 'session', doc })));
    const pending = await s.replica.read.pendingCount();
    await s.intents.settleLapsed();
    expect(await s.replica.read.pendingCount()).toBe(pending);
  });
});

describe('reopening a settled session', () => {
  async function settled() {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const doc = await logged(s);
    s.later(10 * MINUTE);
    await s.intents.logSet(benchOn(), lbs(100, 7));
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    return { ...s, doc };
  }
  const minutesOf = async ({ replica }: Pick<Setup, 'replica'>) => (await replica.read.all('workout')).map((w) => w.minutes);

  it('keeps one session, reopens it on a new set, and the workout converges at the next settle', async () => {
    const s = await settled();
    expect(await minutesOf(s)).toEqual([10]);
    await s.intents.logSet(rowOn(), lbs(50, 10));
    const lastTap = s.at();
    expect((await sessionOf(s)).id).toBe(s.doc.id);
    expect((await sessionOf(s)).finishedAt).toBeUndefined();
    expect(await minutesOf(s), 'the workout waits for the settle').toEqual([10]);

    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    expect((await sessionOf(s)).finishedAt).toBe(lastTap);
    expect(await minutesOf(s), 'first set to last').toEqual([6 * 60 + 10]);
    expect((await s.replica.read.all('workout')).map((w) => w.id)).toEqual([sessionWorkoutId(s.doc)]);
  });

  it('undo of that set closes it again', async () => {
    const s = await settled();
    const finishedAt = (await sessionOf(s)).finishedAt;
    const undo = await s.intents.logSet(rowOn(), lbs(50, 10));
    await undo?.();
    expect((await sessionOf(s)).finishedAt).toBe(finishedAt);
  });

  it('reopens on an edit too, so a shorter day shows in the workout', async () => {
    const s = await settled();
    await s.intents.editSet({ performanceId: benchId(s.doc), index: 1 }, null);
    expect((await sessionOf(s)).finishedAt).toBeUndefined();
    s.later(MINUTE);
    await s.intents.settleLapsed();
    expect(await minutesOf(s), 'one set left, so one minute').toEqual([1]);
  });

  it('removes the session and its workout once its last set is deleted, and the day is not done', async () => {
    const s = await settled();
    await s.intents.editSet({ performanceId: benchId(s.doc), index: 1 }, null);
    await s.intents.editSet({ performanceId: benchId(s.doc), index: 0 }, null);
    expect(await doneDays(s)).toEqual([]);
    await s.intents.settleLapsed();
    expect(await s.replica.read.all('session')).toEqual([]);
    expect(await s.replica.read.all('workout')).toEqual([]);
  });

  it('keeps a session holding a tick when its sets go, but not the workout it no longer earns', async () => {
    const s = await settled();
    await s.intents.checkBlock(PUSH, warmUp.id);
    await s.intents.editSet({ performanceId: benchId(s.doc), index: 1 }, null);
    await s.intents.editSet({ performanceId: benchId(s.doc), index: 0 }, null);
    await s.intents.settleLapsed();
    expect((await sessionOf(s)).checked).toEqual([warmUp.id]);
    expect(await s.replica.read.all('workout')).toEqual([]);
  });
});

describe('the budget after a day with cardio inside it', () => {
  const goal = (policy: GoalDraft['policy']): GoalDraft => ({ policy, kgPerWeek: -0.45, macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 } });

  async function withCardio(policy: GoalDraft['policy']) {
    const s = await setup();
    await s.intents.saveProfile({ sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 });
    await s.intents.saveGoal(goal(policy), TODAY);
    await s.intents.logWeight(80, TODAY);
    const untrained = (await dayView(s.replica.read, TODAY)).budget?.kcal;
    const doc = await logged(s);
    s.later(30 * MINUTE);
    await s.intents.logWorkout(metDraft('run_6', 20), TODAY);
    s.later(30 * MINUTE);
    await s.intents.logSet(rowOn(), lbs(50, 10));
    s.later(6 * HOUR);
    await s.intents.settleLapsed();
    const after = await dayView(s.replica.read, TODAY);
    return { ...s, doc, untrained, after };
  }

  it('does not move under activity-level', async () => {
    const { after, untrained, doc } = await withCardio({ kind: 'activity-level', level: 'moderate' });
    expect(after.budget?.kcal).toBe(untrained);
    expect(after.budget?.workoutKcal).toBe(0);
    expect(after.workouts.find((w) => w.id === sessionWorkoutId(doc))?.minutes).toBe(40);
  });

  it('moves under eat-back by lifting minutes only, with cardio counted once', async () => {
    const { after, untrained, doc } = await withCardio({ kind: 'eat-back-workouts', fraction: 1 });
    const lifting = after.workouts.find((w) => w.id === sessionWorkoutId(doc));
    const run = after.workouts.find((w) => w.id !== sessionWorkoutId(doc));
    expect(lifting?.minutes).toBe(40);
    // 2.5 MET above resting × 80 kg × 40 min, and 8.3 × 80 kg × 20 min.
    expect(lifting?.kcal).toBe(133);
    expect(run?.kcal).toBe(221);
    expect(after.budget?.workoutKcal).toBe(354);
    expect(after.budget?.kcal).toBe((untrained ?? 0) + 354);
  });
});

describe('trainedRecentlyView', () => {
  it('holds for three hours after a set, and across midnight', async () => {
    const s = await setup();
    const at = () => ({ today: TODAY, now: s.at() });
    expect(await trainedRecentlyView(s.replica.read, at())).toBe(false);
    await logged(s);
    expect(await trainedRecentlyView(s.replica.read, at())).toBe(true);
    expect(await trainedRecentlyView(s.replica.read, { today: addDays(TODAY, 1), now: s.at() })).toBe(true);
    s.later(3 * HOUR);
    expect(await trainedRecentlyView(s.replica.read, at())).toBe(false);
  });
});
