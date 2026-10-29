/**
 * Drives real replicas (fake-indexeddb) and a real DocStore through random schedules where
 * the network drops requests, drops responses, delivers twice, and local writes land while
 * a request is in flight. Then checks that everyone converges and nothing applied twice.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { FoodId } from '../src/domain/ids.js';
import type { Kind, Mutation } from '../src/domain/kinds.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, food, newClientId, newEntryId, request } from './fixtures.js';

const ENTRY_IDS = Array.from({ length: 4 }, newEntryId);
const FOOD_IDS = [FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100'), FoodId.parse('1f1e1d1c-1b1a-4918-9716-151413121110')];
const SLOTS = ENTRY_IDS.length + FOOD_IDS.length;

/** Small pages and batches so every schedule exercises multi-round pushes and pulls. */
const PULL_PAGE = 3;
const PUSH_BATCH = 4;

type WriteOp = { readonly op: 'put'; readonly slot: number; readonly kcal: number } | { readonly op: 'delete'; readonly slot: number };
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
  | { readonly kind: 'backup' }
  | { readonly kind: 'restore' };

function toMutation(w: WriteOp): Mutation {
  const entryId = ENTRY_IDS[w.slot];
  if (entryId !== undefined) {
    return w.op === 'put' ? { op: 'put', kind: 'entry', doc: entry(entryId, w.kcal) } : { op: 'delete', kind: 'entry', id: entryId };
  }
  const foodId = FOOD_IDS[w.slot - ENTRY_IDS.length];
  if (foodId === undefined) throw new Error(`no slot ${w.slot}`);
  return w.op === 'put'
    ? { op: 'put', kind: 'food', doc: { ...food(foodId), name: `Food ${w.kcal}` } }
    : { op: 'delete', kind: 'food', id: foodId };
}

const writeOp: fc.Arbitrary<WriteOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant('put' as const), slot: fc.nat(SLOTS - 1), kcal: fc.integer({ min: 1, max: 2000 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), slot: fc.nat(SLOTS - 1) }) },
);

function schedule(replicas: number, withRestore: boolean): fc.Arbitrary<Step[]> {
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
  return fc.array(fc.oneof(...steps), { minLength: 1, maxLength: 60 });
}

interface World {
  server: DocStore;
  readonly replicas: readonly { readonly replica: Replica; readonly port: SyncPort }[];
  /** Every mutation committed on any replica, in commit order. */
  readonly committed: Mutation[];
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
    const ctx = { now: at(1), userAgent: null };
    const first = world.server.sync(req, ctx);
    if (!interleaved) {
      interleaved = true;
      await commit(world, index, during);
    }
    if (fate === 'drop-response') throw new Dropped('response lost');
    if (fate === 'deliver-twice') {
      const port = world.replicas[index]?.port;
      await port?.apply(first);
      return world.server.sync(req, ctx);
    }
    return first;
  };
}

const deliver = (world: World): Transport => (req) => Promise.resolve(world.server.sync(req, { now: at(1), userAgent: null }));

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
  for (const kind of ['entry', 'food'] satisfies Kind[]) {
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

async function run(steps: readonly Step[], replicaCount: number, afterStep?: (world: World) => Promise<void>): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fuel-sim-'));
  const world: World = {
    server: openStore(':memory:', { pageSize: PULL_PAGE }),
    replicas: await Promise.all(
      Array.from({ length: replicaCount }, (_, i) => openReplica({ name: `sim-${i}`, indexedDB: new IDBFactory(), IDBKeyRange })),
    ),
    committed: [],
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

  // Fault-free rounds until every outbox is empty and every replica has pulled the end state.
  for (let pass = 0; pass < 10; pass++) {
    for (const { port } of world.replicas) await syncRounds(port, deliver(world), PUSH_BATCH);
    const pending = await Promise.all(world.replicas.map(({ port }) => port.pendingCount()));
    if (pending.every((n) => n === 0)) break;
  }
  for (const { port } of world.replicas) await syncRounds(port, deliver(world), PUSH_BATCH);
  return world;
}

async function close(world: World): Promise<void> {
  world.server.close();
  for (const { replica } of world.replicas) replica.close();
  await Promise.resolve();
}

const runs = Number(process.env.FUEL_SIM_RUNS ?? 150);
const seed = process.env.FUEL_SIM_SEED === undefined ? {} : { seed: Number(process.env.FUEL_SIM_SEED) };

describe('sync simulation', () => {
  it('one phone: it always shows its own latest writes, the server ends where the phone left it, and every write applies once', async () => {
    const readYourWrites = async (world: World) => {
      const phone = world.replicas[0];
      if (phone) expect(await replicaDocs(phone.replica)).toEqual(modelOf(world.committed));
    };
    await fc.assert(
      fc.asyncProperty(schedule(1, false), async (steps) => {
        const world = await run(steps, 1, readYourWrites);
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
      fc.asyncProperty(fc.integer({ min: 2, max: 3 }).chain((n) => fc.tuple(fc.constant(n), schedule(n, false))), async ([n, steps]) => {
        const world = await run(steps, n);
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
      fc.asyncProperty(schedule(1, true), async (steps) => {
        const world = await run(steps, 1);
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
