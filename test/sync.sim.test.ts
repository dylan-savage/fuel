/**
 * Drives real replicas (fake-indexeddb) and a real DocStore through random schedules where
 * the network drops requests, drops responses, delivers twice, and local writes land while
 * a request is in flight. Then checks that everyone converges and nothing applied twice.
 * The same invariants run again with shells older than the server, which skip what they
 * cannot read and update partway through. A coach publishes through the real route between
 * phone syncs, while phones hold open sessions and offline outboxes.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { PROFILE_ID, goalId } from '../src/domain/goals.js';
import { weighInId } from '../src/domain/body.js';
import { FastEndId, FastId, FoodId, LocalDate, RecipeId, SavedMealId, SessionId, TrainingNoteId, WaterId, WorkoutId, addDays, type ProgramId } from '../src/domain/ids.js';
import { KIND_NAMES, type Kind, type Mutation } from '../src/domain/kinds.js';
import { performanceId, type SetLog } from '../src/domain/lifts.js';
import { programId, type Program } from '../src/domain/program.js';
import { PublishAnswer, Rev, type SyncReply, type SyncRequest, type SyncResponse } from '../src/protocol.js';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, fast, fastEnd, food, goal, newClientId, newEntryId, profile, recipe, request, savedMeal, water, weighIn, workout } from './fixtures.js';
import { lb, lift, liftsBlock, ms, newSessionId, noFoods, noonOf, performance, program, session, slot, slotId } from './training.fixtures.js';

const ENTRY_IDS = Array.from({ length: 4 }, newEntryId);
const FOOD_IDS = [FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100'), FoodId.parse('1f1e1d1c-1b1a-4918-9716-151413121110')];
/** Goals and the profile have fixed ids, so every phone writes the same documents. */
const GOAL_DATES = [LocalDate.parse('2026-10-01'), LocalDate.parse('2026-10-28')];
const RECIPE_ID = RecipeId.parse('2f2e2d2c-2b2a-4928-a726-252423222120');
const MEAL_ID = SavedMealId.parse('3f3e3d3c-3b3a-4938-b736-353433323130');
const WATER_IDS = [WaterId.parse('4f4e4d4c-4b4a-4948-8746-454443424140'), WaterId.parse('5f5e5d5c-5b5a-4958-9756-555453525150')];
const FAST_ID = FastId.parse('6f6e6d6c-6b6a-4968-a766-656463626160');
/** Two phones ending the same fast. */
const FAST_END_IDS = [FastEndId.parse('7f7e7d7c-7b7a-4978-b776-757473727170'), FastEndId.parse('8f8e8d8c-8b8a-4988-8786-858483828180')];
/** Weigh-ins have one id per day, so phones weighing in on the same day write the same document. */
const WEIGH_IN_DATES = ['2026-10-27', '2026-10-28'];
const WORKOUT_IDS = [WorkoutId.parse('9f9e9d9c-9b9a-4998-9796-959493929190'), WorkoutId.parse('afaeadac-abaa-49a8-a7a6-a5a4a3a2a1a0')];
/** The app has no phone write of a program, but a restore re-pushes one through this same outbox, so phones carry them here. */
const PROGRAM_DATES = ['2026-10-26', '2026-11-02'];
const SESSION_IDS = [SessionId.parse('bfbebdbc-bbba-49b8-b7b6-b5b4b3b2b1b0'), SessionId.parse('cfcecdcc-cbca-49c8-87c6-c5c4c3c2c1c0')];
const NOTE_IDS = [TrainingNoteId.parse('dfdedddc-dbda-49d8-97d6-d5d4d3d2d1d0'), TrainingNoteId.parse('efeeedec-ebea-49e8-a7e6-e5e4e3e2e1e0')];
const PUSH_DAY = [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }];

/** Small pages and batches so every schedule exercises multi-round pushes and pulls. */
const PULL_PAGE = 3;
const PUSH_BATCH = 4;

type WriteOp = { readonly op: 'put'; readonly slot: number; readonly kcal: number } | { readonly op: 'delete'; readonly slot: number };

type SlotWrite<K extends Kind> = (w: WriteOp) => Extract<Mutation, { readonly kind: K }>;

/**
 * One document per slot, so random writes collide on the same ids across phones. Keyed by
 * kind, so a new kind fails tsc until the simulation writes it.
 */
const SLOT_WRITES: { readonly [K in Kind]: readonly SlotWrite<K>[] } = {
  entry: ENTRY_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'entry', doc: entry(id, w.kcal) } : { op: 'delete', kind: 'entry', id })),
  food: FOOD_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'food', doc: { ...food(id), name: `Food ${w.kcal}` } } : { op: 'delete', kind: 'food', id })),
  goal: GOAL_DATES.map((date) => (w) => (w.op === 'put' ? { op: 'put', kind: 'goal', doc: goal(date, w.kcal) } : { op: 'delete', kind: 'goal', id: goalId(date) })),
  profile: [(w) => (w.op === 'put' ? { op: 'put', kind: 'profile', doc: profile(40 + w.kcal / 100) } : { op: 'delete', kind: 'profile', id: PROFILE_ID })],
  recipe: [(w) => (w.op === 'put' ? { op: 'put', kind: 'recipe', doc: recipe(RECIPE_ID, w.kcal) } : { op: 'delete', kind: 'recipe', id: RECIPE_ID })],
  savedMeal: [(w) => (w.op === 'put' ? { op: 'put', kind: 'savedMeal', doc: savedMeal(MEAL_ID, w.kcal) } : { op: 'delete', kind: 'savedMeal', id: MEAL_ID })],
  water: WATER_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'water', doc: water(id, w.kcal) } : { op: 'delete', kind: 'water', id })),
  fast: [(w) => (w.op === 'put' ? { op: 'put', kind: 'fast', doc: fast(FAST_ID, 1 + (w.kcal % 72)) } : { op: 'delete', kind: 'fast', id: FAST_ID })],
  fastEnd: FAST_END_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'fastEnd', doc: fastEnd(id, FAST_ID, w.kcal) } : { op: 'delete', kind: 'fastEnd', id })),
  weighIn: WEIGH_IN_DATES.map(
    (date) => (w) => (w.op === 'put' ? { op: 'put', kind: 'weighIn', doc: weighIn(date, 40 + w.kcal / 100) } : { op: 'delete', kind: 'weighIn', id: weighInId(LocalDate.parse(date)) }),
  ),
  workout: WORKOUT_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'workout', doc: workout(id, 40 + w.kcal / 100) } : { op: 'delete', kind: 'workout', id })),
  program: PROGRAM_DATES.map(
    (date) => (w) => (w.op === 'put' ? { op: 'put', kind: 'program', doc: program(date, PUSH_DAY, { publishedAt: ms(w.kcal) }) } : { op: 'delete', kind: 'program', id: programId(LocalDate.parse(date)) }),
  ),
  session: SESSION_IDS.map((id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'session', doc: session({ id, note: `Session ${w.kcal}` }) } : { op: 'delete', kind: 'session', id })),
  performance: SESSION_IDS.map(
    (id) => (w) =>
      w.op === 'put'
        ? { op: 'put', kind: 'performance', doc: performance({ session: id, slot: 'a1', lift: 'bench-press', sets: [lb(w.kcal, 8)] }) }
        : { op: 'delete', kind: 'performance', id: performanceId(id, slotId('a1'), lift('bench-press')) },
  ),
  trainingNote: NOTE_IDS.map(
    (id) => (w) => (w.op === 'put' ? { op: 'put', kind: 'trainingNote', doc: { id, date: LocalDate.parse('2026-10-28'), text: `Note ${w.kcal}`, at: at(w.kcal) } } : { op: 'delete', kind: 'trainingNote', id }),
  ),
};
const ALL_SLOTS = KIND_NAMES.flatMap((kind): readonly ((w: WriteOp) => Mutation)[] => SLOT_WRITES[kind]);
const SLOTS = ALL_SLOTS.length;
/** What the app itself can write. Only a restore pushes a program, and a coached schedule has none. */
const PHONE_SLOTS = ALL_SLOTS.flatMap((write, slot) => (write({ op: 'delete', slot }).kind === 'program' ? [] : [slot]));

type Fate = 'deliver' | 'drop-request' | 'drop-response' | 'deliver-twice';
type Step =
  | { readonly kind: 'write'; readonly replica: number; readonly ops: readonly WriteOp[] }
  | {
      readonly kind: 'sync';
      readonly replica: number;
      readonly fate: Fate;
      /** Local writes that land while the first request is in flight. */
      readonly during: readonly WriteOp[];
      /** Round trips before the network goes away mid-sync. */
      readonly roundTrips: number;
    }
  | { readonly kind: 'update'; readonly replica: number }
  | { readonly kind: 'backup' }
  | { readonly kind: 'restore' }
  | {
      readonly kind: 'publish';
      /** Days from today. Negative aims at a version already in effect. */
      readonly startsIn: number;
      /** Tells contents apart, and a repeat of one makes a repeat publish. */
      readonly text: number;
      /** An old read echoes a rev from before the last read. */
      readonly read: 'fresh' | 'old';
      readonly fate: 'deliver' | 'lost-response';
    }
  | { readonly kind: 'open'; readonly replica: number }
  | { readonly kind: 'set'; readonly replica: number; readonly reps: number }
  | { readonly kind: 'tomorrow' };

function toMutation(w: WriteOp): Mutation {
  const write = ALL_SLOTS[w.slot];
  if (write === undefined) throw new Error(`no slot ${w.slot}`);
  return write(w);
}

const writeOpOver = (slot: fc.Arbitrary<number>): fc.Arbitrary<WriteOp> =>
  fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant('put' as const), slot, kcal: fc.integer({ min: 1, max: 2000 }) }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), slot }) },
  );

function schedule(replicas: number, withRestore: boolean, withUpdates = false, coached = false, length: fc.ArrayConstraints = { minLength: 1, maxLength: 60 }): fc.Arbitrary<Step[]> {
  const replica = fc.nat(replicas - 1);
  const writeOp = writeOpOver(coached ? fc.constantFrom(...PHONE_SLOTS) : fc.nat(SLOTS - 1));
  const steps: fc.WeightedArbitrary<Step>[] = [
    { weight: 5, arbitrary: fc.record({ kind: fc.constant('write' as const), replica, ops: fc.array(writeOp, { minLength: 1, maxLength: 3 }) }) },
    // A long offline stretch: many writes before the next successful sync.
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('write' as const), replica, ops: fc.array(writeOp, { minLength: 10, maxLength: 40 }) }) },
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant('sync' as const),
        replica,
        fate: fc.constantFrom<Fate>('deliver', 'drop-request', 'drop-response', 'deliver-twice'),
        during: fc.array(writeOp, { maxLength: 2 }),
        roundTrips: fc.integer({ min: 1, max: 4 }),
      }),
    },
  ];
  if (withRestore) {
    steps.push({ weight: 1, arbitrary: fc.constant({ kind: 'backup' as const }) });
    steps.push({ weight: 1, arbitrary: fc.constant({ kind: 'restore' as const }) });
  }
  if (withUpdates) steps.push({ weight: 1, arbitrary: fc.record({ kind: fc.constant('update' as const), replica }) });
  if (coached) {
    steps.push({
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('publish' as const),
        startsIn: fc.constantFrom(-1, 0, 1, 2, 7),
        text: fc.integer({ min: 1, max: 3 }),
        read: fc.constantFrom<'fresh' | 'old'>('fresh', 'fresh', 'old'),
        fate: fc.constantFrom<'deliver' | 'lost-response'>('deliver', 'lost-response'),
      }),
    });
    steps.push({ weight: 2, arbitrary: fc.record({ kind: fc.constant('open' as const), replica }) });
    steps.push({ weight: 3, arbitrary: fc.record({ kind: fc.constant('set' as const), replica, reps: fc.integer({ min: 1, max: 20 }) }) });
    steps.push({ weight: 2, arbitrary: fc.constant({ kind: 'tomorrow' as const }) });
  }
  return fc.array(fc.oneof(...steps), length);
}

/**
 * Most runs start with phones that have reported in and a version in effect, because random
 * steps alone almost never reached a pin, and the rest start at the gate. Long, because what is
 * under test takes several steps in a row.
 */
function coachedSchedule(replicas: number, older: boolean): fc.Arbitrary<Step[]> {
  const publishToday: Step = { kind: 'publish', startsIn: 0, text: 1, read: 'fresh', fate: 'deliver' };
  const startedUp: Step[] = [...Array.from({ length: replicas }, (_, replica): Step => ({ kind: 'sync', replica, fate: 'deliver', during: [], roundTrips: 4 })), publishToday];
  const opening = fc.constantFrom(startedUp, startedUp, startedUp, [publishToday]);
  return fc.tuple(opening, schedule(replicas, false, older, true, { minLength: 25, maxLength: 50, size: 'max' })).map(([first, rest]) => [...first, ...rest]);
}

/** A session a phone started, and what it pinned as that phone held it then. */
interface Pin {
  readonly replica: number;
  readonly session: SessionId;
  readonly date: LocalDate;
  readonly programId: ProgramId;
  readonly plan: Program;
  sets: readonly SetLog[];
}

interface Coach {
  today: LocalDate;
  /** The rev of the read before the last, so a publish can be stale. */
  oldRead: Rev;
  /** Every version the store answered as published. */
  readonly landed: Map<string, unknown>;
  published: number;
  readonly pins: Pin[];
}

interface World {
  server: DocStore;
  replicas: readonly Phone[];
  /** Every mutation committed on any replica, in commit order. */
  readonly committed: Mutation[];
  /** Phones still on a shell older than the server. */
  readonly older: Set<number>;
  readonly coach: Coach;
}

interface Phone {
  readonly replica: Replica;
  readonly port: SyncPort;
  readonly indexedDB: IDBFactory;
}

async function openPhone(index: number, indexedDB: IDBFactory, build: string): Promise<Phone> {
  return { indexedDB, ...(await openReplica({ name: `sim-${index}`, indexedDB, IDBKeyRange, build })) };
}

/** A banner tap: the same database reopened under the build that reads everything. */
async function update(world: World, index: number): Promise<void> {
  const phone = world.replicas[index];
  if (phone === undefined || !world.older.delete(index)) return;
  phone.replica.close();
  world.replicas = world.replicas.with(index, await openPhone(index, phone.indexedDB, 'new'));
}

/** What an older shell receives: waters as a kind it never heard of, workouts in a shape its schema rejects. */
function asOlderShell(res: SyncResponse): SyncReply {
  return {
    ...res,
    changes: res.changes.map((c) => {
      if (c.kind === 'water') return { ...c, kind: 'futureKind' };
      if (c.kind === 'workout' && c.doc !== null) return { ...c, doc: { id: c.id } };
      return c;
    }),
  };
}

function answer(world: World, index: number, req: SyncRequest): SyncReply {
  const res = world.server.sync(req, { now: at(1), userAgent: null });
  return world.older.has(index) ? asOlderShell(res) : res;
}

async function commitAll(world: World, index: number, mutations: readonly Mutation[]): Promise<void> {
  await world.replicas[index]?.replica.commit(mutations);
  world.committed.push(...mutations);
}

const commit = (world: World, index: number, ops: readonly WriteOp[]) => commitAll(world, index, ops.map(toMutation));

class Dropped extends Error {}

function transport(world: World, index: number, step: Extract<Step, { kind: 'sync' }>): Transport {
  const { fate, during, roundTrips } = step;
  let interleaved = false;
  let calls = 0;
  return async (req) => {
    if (++calls > roundTrips) throw new Dropped('network gone');
    if (fate === 'drop-request') throw new Dropped('request lost');
    const first = answer(world, index, req);
    if (!interleaved) {
      interleaved = true;
      await commit(world, index, during);
    }
    if (fate === 'drop-response') throw new Dropped('response lost');
    if (fate === 'deliver-twice') {
      const port = world.replicas[index]?.port;
      await port?.apply(first);
      return answer(world, index, req);
    }
    return first;
  };
}

const deliver = (world: World, index: number): Transport => (req) => Promise.resolve(answer(world, index, req));

/** The server's live documents, read the way a brand-new phone would. */
function serverDocs(server: DocStore): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  let res = server.sync(request(newClientId(), []), { now: at(1), userAgent: null });
  for (;;) {
    for (const c of res.changes) {
      if (c.doc === null) docs.delete(`${c.kind}/${c.id}`);
      else docs.set(`${c.kind}/${c.id}`, c.doc);
    }
    if (!res.more) return docs;
    res = server.sync(request(newClientId(), [], res.cursor, res.epoch), { now: at(1), userAgent: null });
  }
}

async function replicaDocs(replica: Replica): Promise<Map<string, unknown>> {
  const docs = new Map<string, unknown>();
  for (const kind of KIND_NAMES) {
    for (const doc of await replica.read.all(kind)) docs.set(`${kind}/${doc.id}`, doc);
  }
  return docs;
}

/** What one phone's own writes imply, applied in order. */
function modelOf(mutations: readonly Mutation[]): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  for (const m of mutations) {
    if (m.op === 'put') docs.set(`${m.kind}/${m.doc.id}`, m.doc);
    else docs.delete(`${m.kind}/${m.id}`);
  }
  return docs;
}

const isProgram = (key: string) => key.startsWith('program/');

function partOf(docs: Map<string, unknown>, keep: (key: string) => boolean): Map<string, unknown> {
  return new Map([...docs].filter(([key]) => keep(key)));
}

/** Everything but the coach's kind, all of which a phone wrote. */
const phoneDocsIn = (docs: Map<string, unknown>) => partOf(docs, (key) => !isProgram(key));

const programsIn = (docs: Map<string, unknown>) => partOf(docs, isProgram);

/** How often a coached schedule reached each case, so a property cannot pass by never getting there. */
const reached = new Map<string, number>();
const reach = (what: string) => reached.set(what, (reached.get(what) ?? 0) + 1);

const ReadRev = z.looseObject({ basedOnRev: Rev });

/**
 * One coach run through the real routes. Whatever it answers, every phone document and any
 * version already in effect stay as they were, and a retry of a lost response lands nowhere new.
 */
async function coachPublishes(world: World, step: Extract<Step, { kind: 'publish' }>): Promise<void> {
  const { coach, server } = world;
  const app = buildApp({ store: server, foods: noFoods, ai: null, staticDir: '.', now: () => noonOf(coach.today) });
  const read = ReadRev.parse(await (await app.request('/api/train/snapshot')).json()).basedOnRev;
  const basedOnRev = step.read === 'fresh' ? read : coach.oldRead;
  coach.oldRead = read;

  const effectiveFrom = addDays(coach.today, step.startsIn);
  const { id: _id, publishedAt: _publishedAt, ...draft } = program(effectiveFrom, PUSH_DAY, { notes: [{ text: `Coach ${step.text}` }] });
  const send = async () => {
    const res = await app.request('/api/train/publish', { method: 'POST', body: JSON.stringify({ basedOnRev, ...draft }) });
    return PublishAnswer.parse(await res.json());
  };

  const before = serverDocs(server);
  const beforeRev = server.stats().rev;
  const beforePhones = await Promise.all(world.replicas.map(({ replica }) => replicaDocs(replica)));

  const answer = await send();
  reach(answer.status);
  const outboxes = await Promise.all(world.replicas.map(({ port }) => port.pendingCount()));
  if (coach.pins.some((pin) => (outboxes[pin.replica] ?? 0) > 0)) reach('over an open session and an outbox');
  if (step.fate === 'lost-response') expect((await send()).status).toBe(answer.status === 'published' ? 'unchanged' : answer.status);

  const after = serverDocs(server);
  expect(phoneDocsIn(after), 'a publish changes no document a phone wrote').toEqual(phoneDocsIn(before));
  expect(await Promise.all(world.replicas.map(({ replica }) => replicaDocs(replica))), 'a publish reaches a phone only by its sync').toEqual(beforePhones);
  for (const [key, version] of programsIn(before)) {
    if (key <= `program/${programId(coach.today)}`) expect(after.get(key), 'a version in effect never changes').toEqual(version);
  }

  const id = `program/${programId(effectiveFrom)}`;
  if (answer.status === 'published') {
    expect(server.stats().rev).toBe(beforeRev + 1);
    expect(after.get(id)).toMatchObject({ ...draft, id: programId(effectiveFrom), publishedAt: noonOf(coach.today) });
    coach.landed.set(id, after.get(id));
    coach.published += 1;
  } else {
    expect(server.stats().rev).toBe(beforeRev);
    expect(programsIn(after)).toEqual(programsIn(before));
  }
}

/** Starts a session on whatever this phone holds, which may be behind the mini. It stays in the outbox until a sync. */
async function phoneOpensSession(world: World, index: number): Promise<void> {
  const phone = world.replicas[index];
  if (phone === undefined) return;
  const { coach } = world;
  const plan = await phone.replica.read.programOn(coach.today);
  const id = newSessionId();
  await commitAll(world, index, [{ op: 'put', kind: 'session', doc: session({ id, date: coach.today, ...(plan === undefined ? {} : { programId: plan.id }) }) }]);
  if (plan === undefined) return;
  reach('a pinned session');
  coach.pins.push({ replica: index, session: id, date: coach.today, programId: plan.id, plan, sets: [] });
}

async function phoneLogsSet(world: World, index: number, reps: number): Promise<void> {
  const pin = world.coach.pins.findLast((candidate) => candidate.replica === index);
  if (pin === undefined) return;
  pin.sets = [...pin.sets, lb(100, reps)];
  await commitAll(world, index, [{ op: 'put', kind: 'performance', doc: performance({ session: pin.session, date: pin.date, slot: 'a1', lift: 'bench-press', sets: pin.sets }) }]);
}

/**
 * Every session still names what it pinned. The phone reads that version as it did then, or as
 * the mini froze it: a phone that slept through a replacement published before the version's
 * date pins the copy it holds and moves to the mini's on its next sync. The mini's copy never
 * moves once the date has arrived, which coachPublishes checks.
 */
async function pinsHold(world: World): Promise<void> {
  const onMini = new Map(world.server.liveDocs('program').map(({ doc }) => [doc.id, doc]));
  for (const pin of world.coach.pins) {
    const phone = world.replicas[pin.replica];
    if (phone === undefined) throw new Error('no replica');
    expect((await phone.replica.read.get('session', pin.session))?.programId).toBe(pin.programId);
    const held = await phone.replica.read.get('program', pin.programId);
    if (!isDeepStrictEqual(held, pin.plan)) expect(held, 'a pinned version never changes').toEqual(onMini.get(pin.programId));
  }
}

async function run(steps: readonly Step[], replicaCount: number, olderShells: boolean, afterStep?: (world: World) => Promise<void>): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fuel-sim-'));
  const world: World = {
    server: openStore(':memory:', { pageSize: PULL_PAGE }),
    replicas: await Promise.all(Array.from({ length: replicaCount }, (_, i) => openPhone(i, new IDBFactory(), 'old'))),
    committed: [],
    older: new Set(olderShells ? Array.from({ length: replicaCount }, (_, i) => i) : []),
    coach: { today: LocalDate.parse('2030-03-04'), oldRead: Rev.parse(0), landed: new Map(), published: 0, pins: [] },
  };
  let backup: string | null = null;
  let restores = 0;

  for (const step of steps) {
    switch (step.kind) {
      case 'write':
        await commit(world, step.replica, step.ops);
        break;
      case 'sync': {
        const port = world.replicas[step.replica]?.port;
        if (!port) break;
        try {
          await syncRounds(port, transport(world, step.replica, step), PUSH_BATCH);
        } catch (err) {
          if (!(err instanceof Dropped)) throw err;
        }
        break;
      }
      case 'update':
        await update(world, step.replica);
        break;
      case 'backup':
        backup = join(dir, `backup-${restores}.db`);
        await world.server.backup(backup);
        break;
      case 'restore': {
        if (backup === null) break;
        const restored = join(dir, `restored-${restores++}.db`);
        copyFileSync(backup, restored);
        world.server.close();
        world.server = openStore(restored, { pageSize: PULL_PAGE });
        world.server.rotateEpoch();
        break;
      }
      case 'publish':
        await coachPublishes(world, step);
        break;
      case 'open':
        await phoneOpensSession(world, step.replica);
        break;
      case 'set':
        await phoneLogsSet(world, step.replica, step.reps);
        break;
      case 'tomorrow':
        world.coach.today = addDays(world.coach.today, 1);
        break;
    }
    await afterStep?.(world);
  }

  for (let i = 0; i < replicaCount; i++) await update(world, i);

  // Fault-free rounds until every outbox is empty and every replica has pulled the end state.
  const syncAll = async () => {
    for (const [i, { port }] of world.replicas.entries()) await syncRounds(port, deliver(world, i), PUSH_BATCH);
  };
  for (let pass = 0; pass < 10; pass++) {
    await syncAll();
    const pending = await Promise.all(world.replicas.map(({ port }) => port.pendingCount()));
    if (pending.every((n) => n === 0)) break;
  }
  await syncAll();
  return world;
}

async function close(world: World): Promise<void> {
  world.server.close();
  for (const { replica } of world.replicas) replica.close();
  await Promise.resolve();
}

const runs = Number(process.env.FUEL_SIM_RUNS ?? 150);
const seed = process.env.FUEL_SIM_SEED === undefined ? {} : { seed: Number(process.env.FUEL_SIM_SEED) };

it('writes at least one document of every kind', () => {
  expect(KIND_NAMES.filter((kind) => SLOT_WRITES[kind].length === 0)).toEqual([]);
});

describe.each([
  ['shells that read everything', false],
  ['older shells that skip what they cannot read, then update', true],
])('sync simulation with %s', (_name, older) => {
  it('one phone: it always shows its own latest writes, the server ends where the phone left it, and every write applies once', async () => {
    const readYourWrites = async (world: World) => {
      const phone = world.replicas[0];
      if (phone) expect(await replicaDocs(phone.replica)).toEqual(modelOf(world.committed));
    };
    await fc.assert(
      fc.asyncProperty(schedule(1, false, older), async (steps) => {
        const world = await run(steps, 1, older, readYourWrites);
        try {
          const [phone] = world.replicas;
          if (!phone) throw new Error('no replica');
          expect(await phone.port.pendingCount()).toBe(0);
          expect(serverDocs(world.server)).toEqual(modelOf(world.committed));
          expect(await replicaDocs(phone.replica)).toEqual(modelOf(world.committed));
          expect(world.server.stats().rev).toBe(world.committed.length);
        } finally {
          await close(world);
        }
      }),
      { numRuns: runs, ...seed },
    );
  }, 120_000);

  it('several phones converge on the server state, and every write applies once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 3 }).chain((n) => fc.tuple(fc.constant(n), schedule(n, false, older))), async ([n, steps]) => {
        const world = await run(steps, n, older);
        try {
          const truth = serverDocs(world.server);
          for (const { replica, port } of world.replicas) {
            expect(await port.pendingCount()).toBe(0);
            expect(await replicaDocs(replica)).toEqual(truth);
          }
          expect(world.server.stats().rev).toBe(world.committed.length);
        } finally {
          await close(world);
        }
      }),
      { numRuns: runs, ...seed },
    );
  }, 120_000);

  it('a coach publishing between syncs touches no phone document, phones converge on its versions, and a pin never moves', async () => {
    const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    reached.clear();
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }).chain((n) => fc.tuple(fc.constant(n), coachedSchedule(n, older))), async ([n, steps]) => {
          const world = await run(steps, n, older, pinsHold);
          try {
            const truth = serverDocs(world.server);
            expect(programsIn(truth), 'the mini holds what the coach landed').toEqual(world.coach.landed);
            for (const { replica, port } of world.replicas) {
              expect(await port.pendingCount()).toBe(0);
              const held = await replicaDocs(replica);
              expect(programsIn(held), 'every phone holds the coach\'s versions').toEqual(world.coach.landed);
              expect(phoneDocsIn(held)).toEqual(phoneDocsIn(truth));
            }
            if (n === 1) expect(phoneDocsIn(truth)).toEqual(modelOf(world.committed));
            expect(world.server.stats().rev, 'every write and every publish applied once').toBe(world.committed.length + world.coach.published);
            await pinsHold(world);
            for (const pin of world.coach.pins) {
              expect(truth.get(`session/${pin.session}`)).toMatchObject({ programId: pin.programId });
              if (pin.sets.length > 0) expect(truth.get(`performance/${performanceId(pin.session, slotId('a1'), lift('bench-press'))}`)).toMatchObject({ sets: pin.sets });
            }
          } finally {
            await close(world);
          }
        }),
        { numRuns: runs, ...seed },
      );
    } finally {
      quiet.mockRestore();
    }
    if (runs >= 100) {
      for (const what of ['published', 'unchanged', 'frozen', 'stale', 'invalid', 'phone_behind', 'a pinned session', 'over an open session and an outbox']) {
        expect(reached.get(what) ?? 0, `the schedules reached ${what}`).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it('after the server is restored from an older backup, the phone puts back everything it holds', async () => {
    await fc.assert(
      fc.asyncProperty(schedule(1, true, older), async (steps) => {
        const world = await run(steps, 1, older);
        try {
          const [phone] = world.replicas;
          if (!phone) throw new Error('no replica');
          const truth = serverDocs(world.server);
          expect(await replicaDocs(phone.replica)).toEqual(truth);
          // Deletes made after the backup may come back; every live document must survive as last written.
          for (const [key, doc] of modelOf(world.committed)) expect(truth.get(key)).toEqual(doc);
        } finally {
          await close(world);
        }
      }),
      { numRuns: runs, ...seed },
    );
  }, 120_000);
});
