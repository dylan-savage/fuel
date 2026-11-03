/**
 * Drives real replicas (fake-indexeddb) and a real DocStore through random schedules where
 * the network drops requests, drops responses, delivers twice, and local writes land while
 * a request is in flight. Then checks that everyone converges and nothing applied twice.
 * The same invariants run again with shells older than the server, which skip what they
 * cannot read and update partway through.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { PROFILE_ID, goalId } from '../src/domain/goals.js';
import { weighInId } from '../src/domain/body.js';
import { FastEndId, FastId, FoodId, LocalDate, RecipeId, SavedMealId, WaterId, WorkoutId } from '../src/domain/ids.js';
import { KIND_NAMES, type Kind, type Mutation } from '../src/domain/kinds.js';
import type { SyncReply, SyncRequest, SyncResponse } from '../src/protocol.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, fast, fastEnd, food, goal, newClientId, newEntryId, profile, recipe, request, savedMeal, water, weighIn, workout } from './fixtures.js';

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
};
const ALL_SLOTS = KIND_NAMES.flatMap((kind): readonly ((w: WriteOp) => Mutation)[] => SLOT_WRITES[kind]);
const SLOTS = ALL_SLOTS.length;

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
  | { readonly kind: 'restore' };

function toMutation(w: WriteOp): Mutation {
  const write = ALL_SLOTS[w.slot];
  if (write === undefined) throw new Error(`no slot ${w.slot}`);
  return write(w);
}

const writeOp: fc.Arbitrary<WriteOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant('put' as const), slot: fc.nat(SLOTS - 1), kcal: fc.integer({ min: 1, max: 2000 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), slot: fc.nat(SLOTS - 1) }) },
);

function schedule(replicas: number, withRestore: boolean, withUpdates = false): fc.Arbitrary<Step[]> {
  const replica = fc.nat(replicas - 1);
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
  return fc.array(fc.oneof(...steps), { minLength: 1, maxLength: 60 });
}

interface World {
  server: DocStore;
  replicas: readonly Phone[];
  /** Every mutation committed on any replica, in commit order. */
  readonly committed: Mutation[];
  /** Phones still on a shell older than the server. */
  readonly older: Set<number>;
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

async function commit(world: World, index: number, ops: readonly WriteOp[]): Promise<void> {
  const mutations = ops.map(toMutation);
  await world.replicas[index]?.replica.commit(mutations);
  world.committed.push(...mutations);
}

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

async function run(steps: readonly Step[], replicaCount: number, olderShells: boolean, afterStep?: (world: World) => Promise<void>): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fuel-sim-'));
  const world: World = {
    server: openStore(':memory:', { pageSize: PULL_PAGE }),
    replicas: await Promise.all(Array.from({ length: replicaCount }, (_, i) => openPhone(i, new IDBFactory(), 'old'))),
    committed: [],
    older: new Set(olderShells ? Array.from({ length: replicaCount }, (_, i) => i) : []),
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
