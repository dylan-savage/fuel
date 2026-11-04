/** The session's writes over a real replica: one tap, one commit, one undo, and what the views then read. */
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntents } from '../src/client/intents.js';
import { openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { dayView, openSessionView, sessionPlanView } from '../src/client/views.js';
import { metDraft } from '../src/domain/burn.js';
import type { GoalDraft } from '../src/domain/goals.js';
import { addDays, type Millis } from '../src/domain/ids.js';
import { performanceId } from '../src/domain/lifts.js';
import { sessionWorkoutId, type Session, type SetEntry, type SetPlace } from '../src/domain/session.js';
import { T0, blockId, cardio, checklist, day, dayKey, liftsBlock, ms, program, session, slot, target } from './training.fixtures.js';

const TODAY = day('2030-03-06');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const bench = slot('a1', 'bench-press', 3, { label: 'Bench press', target: target(3, 8, 12) });
const row = slot('a2', 'cable-row', 2, { label: 'Cable row', target: target(2, 8, 12) });
const warmUp = checklist('warm');
const ride = cardio('ride');
const push = { key: 'push', label: 'Push', weekday: 3, blocks: [warmUp, liftsBlock('pair', [bench, row], { restSeconds: 90 }), ride] };
const version = program('2030-03-04', [push]);

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

async function started({ replica, intents, at }: Setup): Promise<Session> {
  await intents.startSession(dayKey('push'), TODAY);
  const logs = await openSessionView(replica.read, { today: TODAY, now: at() });
  if (logs === null) throw new Error('no session opened');
  return logs.session;
}

const lbs = (amount: number, reps: number): SetEntry => ({ load: { kind: 'weight', amount, unit: 'lb' }, reps: { kind: 'total', reps }, warmup: false, note: '' });
const benchIn = (doc: Session): SetPlace => ({ session: doc, slot: bench, lift: { liftId: bench.liftId, label: bench.label } });
const benchId = (doc: Session) => performanceId(doc.id, bench.id, bench.liftId);

async function pendingOps(port: SyncPort) {
  return (await port.nextBatch(100)).mutations.map((m) => `${m.op} ${m.kind}`);
}

async function sets({ replica }: Pick<Setup, 'replica'>, doc: Session) {
  return (await replica.read.get('performance', benchId(doc)))?.sets.map((s) => (s.reps.kind === 'total' ? s.reps.reps : null));
}

describe('startSession', () => {
  it('writes one thin session pinned to the version in effect, and undo removes it', async () => {
    const s = await setup();
    const undo = await s.intents.startSession(dayKey('push'), TODAY);
    const logs = await openSessionView(s.replica.read, { today: TODAY, now: s.at() });
    expect(logs?.session).toMatchObject({ date: TODAY, day: { key: 'push', label: 'Push' }, programId: version.id, startedAt: s.at() });
    expect(await pendingOps(s.port)).toEqual(['put program', 'put session']);
    await undo?.();
    expect(await openSessionView(s.replica.read, { today: TODAY, now: s.at() })).toBeNull();
  });

  it('opens one session on a double tap, and none for a day the plan does not hold', async () => {
    const s = await setup();
    const [first, second] = await Promise.all([s.intents.startSession(dayKey('push'), TODAY), s.intents.startSession(dayKey('push'), TODAY)]);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await s.replica.read.all('session')).toHaveLength(1);
    await first?.();
    expect(await s.intents.startSession(dayKey('legs'), TODAY)).toBeNull();
    expect(await s.intents.startSession(dayKey('push'), day('2030-03-01'))).toBeNull();
  });
});

describe('openSessionView', () => {
  it('ignores a finished, imported, lapsed or future session', async () => {
    const s = await setup();
    const now = s.at();
    const docs = [session({ date: TODAY, startedAt: now, finishedAt: now }), session({ date: TODAY, source: 'notion' }), session({ date: TODAY, startedAt: ms(now - 7 * HOUR) }), session({ date: addDays(TODAY, 1), startedAt: now })];
    await s.replica.commit(docs.map((doc) => ({ op: 'put', kind: 'session', doc })));
    expect(await openSessionView(s.replica.read, { today: TODAY, now })).toBeNull();
  });

  it('keeps the session and its date across midnight', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    const logs = await openSessionView(s.replica.read, { today: addDays(TODAY, 1), now: s.at() });
    expect(logs?.session.date).toBe(TODAY);
    expect(logs?.performances.map((p) => p.date)).toEqual([TODAY]);
  });

  it('answers with cardio from another workout that day, and not with the session\'s own', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    expect((await openSessionView(s.replica.read, { today: TODAY, now: s.at() }))?.cardioDone).toBe(false);
    await s.intents.logWorkout(metDraft('walk_3', 20), TODAY);
    expect((await openSessionView(s.replica.read, { today: TODAY, now: s.at() }))?.cardioDone).toBe(true);
  });
});

describe('sessionPlanView', () => {
  it('reads the pinned version when a newer one takes effect, and a new session pins the newer', async () => {
    const s = await setup();
    const doc = await started(s);
    const renamed = program('2030-03-06', [{ ...push, label: 'Push, renamed' }]);
    await s.replica.commit([{ op: 'put', kind: 'program', doc: renamed }]);
    expect((await sessionPlanView(s.replica.read, doc))?.plan.label).toBe('Push');

    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    await s.intents.finishSession(doc.id);
    const next = await started(s);
    expect(next.programId).toBe(renamed.id);
    expect((await sessionPlanView(s.replica.read, next))?.plan.label).toBe('Push, renamed');
  });

  it('is null off plan and when the phone does not hold the version', async () => {
    const s = await setup();
    expect(await sessionPlanView(s.replica.read, session({ date: TODAY }))).toBeNull();
    expect(await sessionPlanView(s.replica.read, session({ date: TODAY, programId: program('2029-01-07', [push]).id }))).toBeNull();
  });
});

describe('logSet', () => {
  it('stores the tap in one commit, one outbox row per set', async () => {
    const s = await setup();
    const doc = await started(s);
    const before = (await pendingOps(s.port)).length;
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    expect((await pendingOps(s.port)).slice(before)).toEqual(['put performance']);
    expect(await s.replica.read.get('performance', benchId(doc))).toMatchObject({ sessionId: doc.id, date: TODAY, target: bench.target, sets: [{ load: { amount: 100 }, reps: { reps: 8 }, at: s.at() }] });
  });

  it('undoes one set at a time, and the first takes the performance with it', async () => {
    const s = await setup();
    const doc = await started(s);
    const first = await s.intents.logSet(benchIn(doc), lbs(100, 8));
    const second = await s.intents.logSet(benchIn(doc), lbs(100, 7));
    expect(await sets(s, doc)).toEqual([8, 7]);
    await second?.();
    expect(await sets(s, doc)).toEqual([8]);
    await first?.();
    expect(await sets(s, doc)).toBeUndefined();
  });

  it('loses neither of two fast taps', async () => {
    const s = await setup();
    const doc = await started(s);
    await Promise.all([s.intents.logSet(benchIn(doc), lbs(100, 8)), s.intents.logSet(benchIn(doc), lbs(100, 7))]);
    expect(await sets(s, doc)).toEqual([8, 7]);
  });

  it('writes nothing while the entry is incomplete', async () => {
    const s = await setup();
    const doc = await started(s);
    expect(await s.intents.logSet(benchIn(doc), { ...lbs(100, 8), load: { kind: 'weight', amount: null, unit: 'lb' } })).toBeNull();
    expect(await sets(s, doc)).toBeUndefined();
  });

  it('takes a skip back on a set in that slot, and undo puts it back', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.skipSlot(doc.id, bench.id, 'Invented note.');
    const undo = await s.intents.logSet(benchIn(doc), lbs(100, 8));
    expect((await s.replica.read.get('session', doc.id))?.skips).toBeUndefined();
    await undo?.();
    expect((await s.replica.read.get('session', doc.id))?.skips).toEqual([{ slotId: bench.id, note: 'Invented note.' }]);
  });
});

describe('editSet', () => {
  it('changes a set and keeps its tap, its place and what a newer app added', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
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
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    await s.intents.logSet(benchIn(doc), lbs(100, 7));
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
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    await s.intents.editSet({ performanceId: benchId(doc), index: 0 }, { ...lbs(100, 8), reps: { kind: 'total', reps: null } });
    await s.intents.editSet({ performanceId: benchId(doc), index: 5 }, lbs(1, 1));
    expect(await sets(s, doc)).toEqual([8]);
  });
});

describe('notes, skips and ticks', () => {
  it('notes an exercise and the session, blank removes, and undo restores', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    await s.intents.noteExercise(benchId(doc), ' Invented note. ');
    expect((await s.replica.read.get('performance', benchId(doc)))?.note).toBe('Invented note.');
    const undoBlank = await s.intents.noteExercise(benchId(doc), '  ');
    expect(await s.replica.read.get('performance', benchId(doc))).not.toHaveProperty('note');
    await undoBlank();
    expect((await s.replica.read.get('performance', benchId(doc)))?.note).toBe('Invented note.');

    const undoSession = await s.intents.noteSession(doc.id, 'Invented session note.');
    expect((await s.replica.read.get('session', doc.id))?.note).toBe('Invented session note.');
    await undoSession();
    expect(await s.replica.read.get('session', doc.id)).not.toHaveProperty('note');
  });

  it('skips a slot with a note, and undo restores', async () => {
    const s = await setup();
    const doc = await started(s);
    const undo = await s.intents.skipSlot(doc.id, row.id, 'Invented reason.');
    expect((await s.replica.read.get('session', doc.id))?.skips).toEqual([{ slotId: row.id, note: 'Invented reason.' }]);
    await undo();
    expect((await s.replica.read.get('session', doc.id))?.skips).toBeUndefined();
  });

  it('ticks a block, and undo restores', async () => {
    const s = await setup();
    const doc = await started(s);
    const undo = await s.intents.checkBlock(doc.id, warmUp.id);
    expect((await s.replica.read.get('session', doc.id))?.checked).toEqual([blockId('warm')]);
    await undo();
    expect((await s.replica.read.get('session', doc.id))?.checked).toBeUndefined();
  });

  it('writes a loose line to the coach, and undo removes it', async () => {
    const s = await setup();
    const undo = await s.intents.tellCoach(' Invented line. ', TODAY);
    expect(await s.replica.read.all('trainingNote')).toMatchObject([{ date: TODAY, text: 'Invented line.', at: s.at() }]);
    await undo();
    expect(await s.replica.read.all('trainingNote')).toEqual([]);
  });
});

describe('finishSession', () => {
  async function trained() {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    s.later(50 * MINUTE);
    return { ...s, doc };
  }

  it('sets the finish and writes the workout in one commit, reaching the day by the session\'s label', async () => {
    const { intents, replica, port, doc, at } = await trained();
    const before = (await pendingOps(port)).length;
    const finished = await intents.finishSession(doc.id);
    expect(finished).toMatchObject({ kind: 'finished', diary: 'added', minutes: 50 });
    expect((await pendingOps(port)).slice(before)).toEqual(['put session', 'put workout']);
    expect((await replica.read.get('session', doc.id))?.finishedAt).toBe(at());
    expect((await dayView(replica.read, TODAY)).workouts.map((w) => [w.id, w.name, w.minutes])).toEqual([[sessionWorkoutId(doc), 'Push', 50]]);
    expect(await openSessionView(replica.read, { today: TODAY, now: at() })).toBeNull();
  });

  it('leaves one workout when finished twice, at once or later', async () => {
    const s = await trained();
    const [first, second] = await Promise.all([s.intents.finishSession(s.doc.id), s.intents.finishSession(s.doc.id)]);
    expect(first.kind).toBe('finished');
    expect(second.kind).toBe('already');
    s.later(HOUR);
    expect((await s.intents.finishSession(s.doc.id)).kind).toBe('already');
    expect((await s.replica.read.all('workout')).map((w) => [w.id, w.minutes])).toEqual([[sessionWorkoutId(s.doc), 50]]);
  });

  it('undo reopens the session and removes the workout, and finishing again leaves one', async () => {
    const s = await trained();
    const finished = await s.intents.finishSession(s.doc.id);
    if (finished.kind !== 'finished') throw new Error('not finished');
    await finished.undo();
    expect((await openSessionView(s.replica.read, { today: TODAY, now: s.at() }))?.session.id).toBe(s.doc.id);
    expect(await s.replica.read.all('workout')).toEqual([]);
    s.later(10 * MINUTE);
    await s.intents.finishSession(s.doc.id);
    expect((await s.replica.read.all('workout')).map((w) => w.minutes)).toEqual([60]);
  });

  it('writes no workout with no sets, though a session with work still counts as finished', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.checkBlock(doc.id, warmUp.id);
    const finished = await s.intents.finishSession(doc.id);
    expect(finished).toMatchObject({ kind: 'finished', diary: 'no-sets', minutes: null });
    expect(await s.replica.read.all('workout')).toEqual([]);
    expect((await s.replica.read.get('session', doc.id))?.finishedAt).toBe(s.at());
    if (finished.kind === 'finished') await finished.undo();
    expect((await openSessionView(s.replica.read, { today: TODAY, now: s.at() }))?.session.id).toBe(doc.id);
  });

  it('removes a session nothing happened in rather than counting it, and undo brings it back', async () => {
    const s = await setup();
    const doc = await started(s);
    const finished = await s.intents.finishSession(doc.id);
    expect(finished.kind).toBe('dropped');
    expect(await s.replica.read.get('session', doc.id)).toBeUndefined();
    if (finished.kind === 'dropped') await finished.undo();
    expect((await openSessionView(s.replica.read, { today: TODAY, now: s.at() }))?.session.id).toBe(doc.id);
  });

  it('says so when no body weight is known, and still finishes', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    expect(await s.intents.finishSession(doc.id)).toMatchObject({ kind: 'finished', diary: 'no-weight', minutes: null });
    expect(await s.replica.read.all('workout')).toEqual([]);
    expect((await s.replica.read.get('session', doc.id))?.finishedAt).toBe(s.at());
  });

  it('finishes at the last set when tapped long after, so the workout is not hours long', async () => {
    const s = await trained();
    s.later(7 * HOUR);
    expect(await s.intents.finishSession(s.doc.id)).toMatchObject({ kind: 'finished', minutes: 1 });
  });

  it('keeps the session\'s date on a workout finished past midnight', async () => {
    const s = await trained();
    s.later(24 * HOUR);
    await s.intents.finishSession(s.doc.id);
    expect((await s.replica.read.all('workout')).map((w) => w.date)).toEqual([TODAY]);
  });
});

describe('the budget after a session with cardio inside it', () => {
  const goal = (policy: GoalDraft['policy']): GoalDraft => ({ policy, kgPerWeek: -0.45, macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 } });

  async function withCardio(policy: GoalDraft['policy']) {
    const s = await setup();
    await s.intents.saveProfile({ sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 });
    await s.intents.saveGoal(goal(policy), TODAY);
    await s.intents.logWeight(80, TODAY);
    const untrained = (await dayView(s.replica.read, TODAY)).budget?.kcal;
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    s.later(30 * MINUTE);
    await s.intents.logWorkout(metDraft('run_6', 20), TODAY);
    s.later(30 * MINUTE);
    await s.intents.finishSession(doc.id);
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

describe('settleLapsed', () => {
  it('finishes a forgotten session at its last set, once, with its workout', async () => {
    const s = await setup();
    await s.intents.logWeight(80, TODAY);
    const doc = await started(s);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    s.later(10 * MINUTE);
    await s.intents.logSet(benchIn(doc), lbs(100, 8));
    const lastTap = s.at();
    s.later(6 * HOUR - 1);
    expect(await s.intents.settleLapsed()).toEqual([]);
    expect((await s.replica.read.get('session', doc.id))?.finishedAt).toBeUndefined();
    s.later(1);

    expect(await s.intents.settleLapsed()).toEqual([{ label: 'Push', at: lastTap }]);
    expect((await s.replica.read.get('session', doc.id))?.finishedAt).toBe(lastTap);
    expect((await s.replica.read.all('workout')).map((w) => [w.id, w.date, w.minutes, w.loggedAt])).toEqual([[sessionWorkoutId(doc), TODAY, 10, lastTap]]);

    const pending = await s.replica.read.pendingCount();
    expect(await s.intents.settleLapsed()).toEqual([]);
    expect(await s.replica.read.pendingCount()).toBe(pending);
  });

  it('removes a forgotten session nothing happened in', async () => {
    const s = await setup();
    const doc = await started(s);
    s.later(6 * HOUR);
    expect(await s.intents.settleLapsed()).toEqual([]);
    expect(await s.replica.read.get('session', doc.id)).toBeUndefined();
  });

  it('leaves a forgotten session with work but no timed set, which has no time to finish at', async () => {
    const s = await setup();
    const doc = await started(s);
    await s.intents.checkBlock(doc.id, warmUp.id);
    s.later(6 * HOUR);
    expect(await s.intents.settleLapsed()).toEqual([]);
    expect((await s.replica.read.get('session', doc.id))?.finishedAt).toBeUndefined();
    expect((await s.replica.read.get('session', doc.id))?.checked).toEqual([warmUp.id]);
  });

  it('leaves an open session, a finished one and an import alone, and writes nothing', async () => {
    const s = await setup();
    const docs = [session({ date: TODAY, source: 'notion', startedAt: ms(T0 - 100 * HOUR) }), session({ date: TODAY, startedAt: ms(T0 - 100 * HOUR), finishedAt: ms(T0 - 99 * HOUR) }), session({ date: TODAY, startedAt: ms(T0) })];
    await s.replica.commit(docs.map((doc) => ({ op: 'put', kind: 'session', doc })));
    const pending = await s.replica.read.pendingCount();
    expect(await s.intents.settleLapsed()).toEqual([]);
    expect(await s.replica.read.pendingCount()).toBe(pending);
  });
});
