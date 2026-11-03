import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidDocument, openReplica, type Replica } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { lastTimesView } from '../src/client/views.js';
import { Gtin } from '../src/domain/food.js';
import { DB_VERSION, SCHEMA_HISTORY } from '../src/domain/kinds.js';
import { liftBook, type Performance } from '../src/domain/lifts.js';
import { lastSwapAt, lastTimeOf } from '../src/domain/progress.js';
import { ClientId, MutationId, type SyncReply } from '../src/protocol.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, food, newClientId, newEntryId, putEntry, request, rev } from './fixtures.js';
import { day, lb, lift, liftsBlock, newSessionId, performance, program, session, slot } from './training.fixtures.js';

const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function setup() {
  const opened = await openReplica({ name: 'replica', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(opened.replica);
  return opened;
}

const response = (fields: Partial<SyncReply>): SyncReply => ({
  epoch: 'e1',
  lastMutationId: 1,
  rejected: [],
  changes: [],
  cursor: rev(0),
  more: false,
  ...fields,
});

describe('Replica.commit', () => {
  it('refuses a batch holding a document its kind would reject, writing and queueing none of it', async () => {
    const { replica, port } = await setup();
    const good = entry(newEntryId(), 400);
    const bad = { ...entry(newEntryId(), 400), quantity: { kind: 'amount' as const, amount: -1 } };
    await expect(
      replica.commit([
        { op: 'put', kind: 'entry', doc: good },
        { op: 'put', kind: 'entry', doc: bad },
      ]),
    ).rejects.toThrow(InvalidDocument);
    expect(await port.pendingCount()).toBe(0);
    expect(await replica.read.get('entry', good.id)).toBeUndefined();
  });
});

describe('SyncPort.apply', () => {
  it('restores the server copy when the server rejects a write', async () => {
    const { replica, port } = await setup();
    const original = entry(newEntryId(), 400);
    await replica.commit([{ op: 'put', kind: 'entry', doc: { ...original, meal: 'dinner' } }]);
    await port.apply(
      response({
        rejected: [
          {
            mutationId: MutationId.parse(1),
            kind: 'entry',
            docId: original.id,
            reason: 'invalid',
            current: { kind: 'entry', id: original.id, rev: rev(3), doc: original },
          },
        ],
      }),
    );
    expect(await replica.read.get('entry', original.id)).toEqual(original);
    expect(await port.pendingCount()).toBe(0);
  });

  it('removes a rejected document the server never had', async () => {
    const { replica, port } = await setup();
    const doc = entry(newEntryId(), 400);
    await replica.commit([{ op: 'put', kind: 'entry', doc }]);
    await port.apply(
      response({ rejected: [{ mutationId: MutationId.parse(1), kind: 'entry', docId: doc.id, reason: 'invalid', current: null }] }),
    );
    expect(await replica.read.get('entry', doc.id)).toBeUndefined();
  });

});

describe('a pull holding records this shell cannot read', () => {
  const before = entry(newEntryId(), 100);
  const after = entry(newEntryId(), 200);
  const readable = (doc: typeof before, n: number) => ({ kind: 'entry', id: doc.id, rev: rev(n), doc });

  it.each([
    ['an unknown kind', { kind: 'futureKind', id: 'p-1', rev: 2, doc: { id: 'p-1' } }],
    ['a tombstone of an unknown kind', { kind: 'futureKind', id: 'p-1', rev: 2, doc: null }],
    ['a document its schema rejects', { kind: 'entry', id: 'x', rev: 2, doc: { id: 'x' } }],
    ['a record with no shape at all', { nonsense: true }],
  ])('skips %s: the rest applies, the cursor advances and acks clear the outbox', async (_name, unreadable) => {
    const { replica, port } = await setup();
    await replica.commit([{ op: 'put', kind: 'entry', doc: entry(newEntryId(), 1) }]);
    await port.apply(response({ lastMutationId: 1, changes: [readable(before, 1), unreadable, readable(after, 3)], cursor: rev(3) }));

    expect(await replica.read.get('entry', before.id)).toEqual(before);
    expect(await replica.read.get('entry', after.id)).toEqual(after);
    expect(await replica.read.get('entry', 'x')).toBeUndefined();
    expect(await port.pendingCount()).toBe(0);
    expect((await port.nextBatch(1)).cursor).toBe(3);
  });

  it('stays in its one transaction through a long run of documents its schema rejects', async () => {
    const { replica, port } = await setup();
    const rejected = Array.from({ length: 150 }, (_, i) => {
      const id = newEntryId();
      return { kind: 'entry', id, rev: i + 1, doc: { id } };
    });
    const readable = entry(newEntryId(), 400);
    await port.apply(response({ changes: [...rejected, { kind: 'entry', id: readable.id, rev: 151, doc: readable }], cursor: rev(151) }));
    expect(await replica.read.get('entry', readable.id)).toEqual(readable);
    expect((await port.nextBatch(1)).cursor).toBe(151);
  });

  it('keeps the local copy of a document whose newer version it cannot read', async () => {
    const { replica, port } = await setup();
    await port.apply(response({ changes: [readable(before, 1)], cursor: rev(1) }));
    await port.apply(response({ changes: [{ kind: 'entry', id: before.id, rev: rev(2), doc: { id: before.id } }], cursor: rev(2) }));
    expect(await replica.read.get('entry', before.id)).toEqual(before);
  });

  it('does not abort when the server copy returned with a rejection is unreadable', async () => {
    const { replica, port } = await setup();
    const doc = entry(newEntryId(), 400);
    await replica.commit([{ op: 'put', kind: 'entry', doc }]);
    const current = { kind: 'entry' as const, id: doc.id, rev: rev(3), doc: { id: doc.id } };
    await port.apply(response({ rejected: [{ mutationId: MutationId.parse(1), kind: 'entry', docId: doc.id, reason: 'invalid', current }], cursor: rev(3) }));
    expect(await port.pendingCount()).toBe(0);
    expect((await port.nextBatch(1)).cursor).toBe(3);
  });

  it('applies the same response twice with no further change', async () => {
    const { replica, port } = await setup();
    const res = response({ changes: [readable(before, 1), { kind: 'futureKind', id: 'p-1', rev: 2, doc: {} }], cursor: rev(2) });
    await port.apply(res);
    await port.apply(res);
    expect(await replica.read.all('entry')).toEqual([before]);
    expect((await port.nextBatch(1)).cursor).toBe(2);
  });
});

describe('a new build', () => {
  const lunch = entry(newEntryId(), 100);
  const dinner = { ...lunch, meal: 'dinner' as const };
  const unknown = (n: number) => ({ kind: 'futureKind', id: `p-${n}`, rev: n, doc: { id: `p-${n}` } });
  const readable = (n: number) => ({ kind: 'entry', id: lunch.id, rev: n, doc: lunch });
  const cursorOf = async (shell: Awaited<ReturnType<typeof openReplica>>) => (await shell.port.nextBatch(1)).cursor;

  function shells() {
    const indexedDB = new IDBFactory();
    return async (build: string) => {
      const opened = await openReplica({ name: 'builds', indexedDB, IDBKeyRange, build });
      open.push(opened.replica);
      return opened;
    };
  }

  it('pulls from just before the lowest rev an older build skipped, until a response applies', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ changes: [unknown(7), readable(8), unknown(9)], cursor: rev(20) }));
    await old.port.apply(response({ changes: [unknown(21)], cursor: rev(21) }));
    old.replica.close();

    const next = await shell('new');
    expect(await cursorOf(next)).toBe(6);
    expect(await cursorOf(next)).toBe(6);
    await next.port.apply(response({ changes: [readable(8)], cursor: rev(22) }));
    expect(await cursorOf(next)).toBe(22);
    next.replica.close();

    expect(await cursorOf(await shell('newer'))).toBe(22);
  });

  it('sends its build on every request', async () => {
    const { port } = await (shells())('abc-1');
    expect((await port.nextBatch(1)).build).toBe('abc-1');
  });

  it('stays at its cursor when the build has not changed', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ changes: [unknown(7)], cursor: rev(20) }));
    old.replica.close();
    expect(await cursorOf(await shell('old'))).toBe(20);
  });

  it('stays at its cursor when nothing was skipped', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ changes: [readable(7)], cursor: rev(20) }));
    old.replica.close();
    expect(await cursorOf(await shell('new'))).toBe(20);
  });

  it('remembers under its own build what it still cannot read', async () => {
    const shell = shells();
    const first = await shell('first');
    await first.port.apply(response({ changes: [unknown(7), unknown(9)], cursor: rev(20) }));
    first.replica.close();

    const second = await shell('second');
    await second.port.apply(response({ changes: [readable(7), unknown(9)], cursor: rev(20) }));
    expect(await cursorOf(second)).toBe(20);
    second.replica.close();

    expect(await cursorOf(await shell('third'))).toBe(8);
  });

  it('re-reads a whole pull when a record held no rev to remember', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ changes: [readable(4)], cursor: rev(4) }));
    await old.port.apply(response({ changes: [readable(5), { nonsense: true }], cursor: rev(6) }));
    old.replica.close();
    expect(await cursorOf(await shell('new'))).toBe(4);
  });

  it('re-pulls the server copy a rejection returned when this shell could not read it', async () => {
    const shell = shells();
    const old = await shell('old');
    const doc = entry(newEntryId(), 400);
    await old.replica.commit([{ op: 'put', kind: 'entry', doc }]);
    const current = { kind: 'entry' as const, id: doc.id, rev: rev(3), doc: { id: doc.id } };
    await old.port.apply(response({ rejected: [{ mutationId: MutationId.parse(1), kind: 'entry', docId: doc.id, reason: 'invalid', current }], cursor: rev(20) }));
    old.replica.close();
    expect(await cursorOf(await shell('new'))).toBe(2);
  });

  it('never jumps forward, past a page it has not pulled yet', async () => {
    const shell = shells();
    const old = await shell('old');
    const doc = entry(newEntryId(), 400);
    await old.replica.commit([{ op: 'put', kind: 'entry', doc }]);
    const current = { kind: 'entry' as const, id: doc.id, rev: rev(5000), doc: { id: doc.id } };
    await old.port.apply(response({ rejected: [{ mutationId: MutationId.parse(1), kind: 'entry', docId: doc.id, reason: 'invalid', current }], cursor: rev(1000), more: true }));
    old.replica.close();
    expect(await cursorOf(await shell('new'))).toBe(1000);
  });

  it('keeps a pending local write over the re-pulled document', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ changes: [readable(7), { ...readable(8), doc: { id: lunch.id } }], cursor: rev(8) }));
    await old.replica.commit([{ op: 'put', kind: 'entry', doc: dinner }]);
    old.replica.close();

    const next = await shell('new');
    await next.port.apply(response({ lastMutationId: 0, changes: [{ ...readable(8), doc: { ...lunch, meal: 'snack' } }], cursor: rev(8) }));
    expect(await next.replica.read.get('entry', lunch.id)).toEqual(dinner);
    expect(await next.port.pendingCount()).toBe(1);
  });

  it('forgets revs from before a restore, which mean nothing to the restored server', async () => {
    const shell = shells();
    const old = await shell('old');
    await old.port.apply(response({ epoch: 'e1', changes: [unknown(2)], cursor: rev(20) }));
    await old.port.apply(response({ epoch: 'e2', changes: [unknown(5)], cursor: rev(10) }));
    old.replica.close();
    expect(await cursorOf(await shell('new'))).toBe(4);

    const none = shells();
    const other = await none('old');
    await other.port.apply(response({ epoch: 'e1', changes: [unknown(2)], cursor: rev(20) }));
    await other.port.apply(response({ epoch: 'e2', changes: [readable(5)], cursor: rev(10) }));
    other.replica.close();
    expect(await cursorOf(await none('new'))).toBe(10);
  });

  it('opens a phone holding a sync row from before skipping existed', async () => {
    const indexedDB = new IDBFactory();
    const before = new Dexie('builds', { indexedDB, IDBKeyRange });
    const latest = SCHEMA_HISTORY.at(-1);
    if (latest === undefined) throw new Error('no schema history');
    before.version(SCHEMA_HISTORY.length).stores(latest);
    const clientId = ClientId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c');
    await before.table('meta').put({ key: 'sync', clientId, epoch: 'e1', cursor: 5 });
    before.close();

    const { replica, port } = await openReplica({ name: 'builds', indexedDB, IDBKeyRange, build: 'new' });
    open.push(replica);
    expect(await port.nextBatch(1)).toMatchObject({ clientId, epoch: 'e1', cursor: 5 });
    await port.apply(response({ changes: [unknown(6)], cursor: rev(6) }));
    expect((await port.nextBatch(1)).cursor).toBe(6);
  });
});

describe('a skipped document when the server is restored from a backup', () => {
  const ctx = { now: at(1), userAgent: null };
  const original = entry(newEntryId(), 100);
  const newer = { ...original, meal: 'dinner' as const };
  const servers: DocStore[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const opened = (path: string) => {
    const server = openStore(path);
    servers.push(server);
    return server;
  };
  /** An older shell's view: the newer version of this document fails its schema. */
  const olderShell = (server: DocStore): Transport => (req) => {
    const res = server.sync(req, ctx);
    return Promise.resolve({ ...res, changes: res.changes.map((c) => (c.doc !== null && c.id === original.id && c.rev > 1 ? { ...c, doc: { id: c.id } } : c)) });
  };
  const onServer = (server: DocStore) => server.sync(request(newClientId(), []), ctx).changes.find((c) => c.id === original.id)?.doc;

  it('comes back from the older local copy, which replaces the newer version when the server accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuel-repush-'));
    const server = opened(join(dir, 'fuel.db'));
    const { replica, port } = await setup();
    await replica.commit([{ op: 'put', kind: 'entry', doc: original }]);
    await syncRounds(port, olderShell(server));

    server.sync(request(newClientId(), [putEntry(1, newer)]), ctx);
    await syncRounds(port, olderShell(server));
    expect(await replica.read.get('entry', original.id)).toEqual(original);
    expect(onServer(server)).toEqual(newer);

    const backup = join(dir, 'backup.db');
    await server.backup(backup);
    const restored = opened(backup);
    restored.rotateEpoch();
    expect(onServer(restored)).toEqual(newer);

    await syncRounds(port, olderShell(restored));
    expect(onServer(restored)).toEqual(original);
    expect(await replica.read.get('entry', original.id)).toEqual(original);
  });

  it('never comes back when its kind is unknown, because the shell holds no copy to re-push', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuel-repush-'));
    const server = opened(join(dir, 'fuel.db'));
    const { port } = await setup();
    const unknownKind: Transport = (req) => {
      const res = server.sync(req, ctx);
      return Promise.resolve({ ...res, changes: res.changes.map((c) => ({ ...c, kind: 'futureKind' })) });
    };
    server.sync(request(newClientId(), [putEntry(1, newer)]), ctx);
    await syncRounds(port, unknownKind);

    const backup = join(dir, 'backup.db');
    await server.backup(backup);
    const restored = opened(backup);
    restored.rotateEpoch();
    const revBefore = restored.stats().rev;
    await syncRounds(port, (req) => Promise.resolve(restored.sync(req, ctx)));
    expect(restored.stats().rev).toBe(revBefore);
    expect(onServer(restored)).toEqual(newer);
  });
});

describe('a program the phone pulled', () => {
  const ctx = { now: at(1), userAgent: null };

  it('goes back to a restored server with everything else the phone holds, then leaves the outbox', async () => {
    const before = openStore(':memory:');
    const restored = openStore(':memory:');
    const { replica, port } = await setup();
    const plan = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }]);
    expect(before.sync(request(newClientId(), [{ op: 'put', id: MutationId.parse(1), kind: 'program', docId: plan.id, doc: plan }]), ctx).rejected).toEqual([]);

    await syncRounds(port, (req) => Promise.resolve(before.sync(req, ctx)));
    expect(await replica.read.get('program', plan.id)).toEqual(plan);

    await syncRounds(port, (req) => Promise.resolve(restored.sync(req, ctx)));
    expect(restored.sync(request(newClientId(), []), ctx).changes.map((c) => c.doc)).toEqual([plan]);
    expect(await port.pendingCount()).toBe(0);
    before.close();
    restored.close();
  });
});

describe('training reads', () => {
  const put = (replica: Replica, rows: readonly Performance[]) => replica.commit(rows.map((doc) => ({ op: 'put', kind: 'performance', doc })));
  const ids = (rows: readonly Performance[]) => rows.map((row) => row.id).toSorted();
  const plan = (date: string) => program(date, [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }]);

  it('finds the program in effect on a date, and a program by id', async () => {
    const { replica } = await setup();
    const versions = [plan('2030-03-04'), plan('2030-03-11'), plan('2030-03-18')];
    await replica.commit(versions.map((doc) => ({ op: 'put', kind: 'program', doc })));
    const onDate = async (date: string) => (await replica.read.programOn(day(date)))?.effectiveFrom;
    expect(await onDate('2030-03-03')).toBeUndefined();
    expect(await onDate('2030-03-04')).toBe('2030-03-04');
    expect(await onDate('2030-03-10')).toBe('2030-03-04');
    expect(await onDate('2030-03-11')).toBe('2030-03-11');
    expect(await onDate('2031-01-01')).toBe('2030-03-18');
    expect(await replica.read.get('program', plan('2030-03-11').id)).toEqual(versions[1]);
  });

  it('leaves the date itself out of the last time, and answers nothing with no history', async () => {
    const { replica } = await setup();
    const older = performance({ date: '2030-03-04', lift: 'bench-press', sets: [lb(100, 8)] });
    const today = performance({ date: '2030-03-11', lift: 'bench-press', sets: [lb(110, 8)] });
    await put(replica, [older, today]);
    expect(await replica.read.lastPerformances([lift('bench-press')], day('2030-03-11'))).toEqual([older]);
    expect(await replica.read.lastPerformances([lift('bench-press')], day('2030-03-04'))).toEqual([]);
    expect(await replica.read.lastPerformances([lift('row')], day('2030-03-11'))).toEqual([]);
  });

  it('reads swaps through the planned lift alone, so a row with no planned lift never answers', async () => {
    const { replica } = await setup();
    const straight = performance({ date: '2030-03-04', lift: 'bench-press', sets: [lb(100, 8)] });
    const swap = performance({ date: '2030-03-05', lift: 'incline-press', planned: 'bench-press', sets: [lb(60, 8)] });
    await put(replica, [straight, swap]);
    expect(await replica.read.lastSwaps([lift('bench-press')], day('2030-03-11'))).toEqual([swap]);
    expect(await replica.read.lastSwaps([lift('incline-press')], day('2030-03-11'))).toEqual([]);
  });

  it('reads the performances of one session', async () => {
    const { replica } = await setup();
    const mine = newSessionId();
    const rows = [
      performance({ session: mine, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8)] }),
      performance({ session: mine, slot: 'a2', lift: 'row', sets: [lb(90, 8)] }),
    ];
    await put(replica, [...rows, performance({ lift: 'bench-press', sets: [lb(100, 8)] })]);
    expect(ids(await replica.read.performancesOfSession(mine))).toEqual(ids(rows));
    expect(await replica.read.performancesOfSession(newSessionId())).toEqual([]);
  });

  it('holds a session by its date too', async () => {
    const { replica } = await setup();
    const doc = session({ date: day('2030-03-04') });
    await replica.commit([{ op: 'put', kind: 'session', doc }]);
    expect(await replica.read.between('session', day('2030-03-04'), day('2030-03-10'))).toEqual([doc]);
  });

  const rowsArbitrary = fc.array(
    fc.record({
      date: fc.constantFrom('2030-03-01', '2030-03-02', '2030-03-03', '2030-03-04'),
      lift: fc.constantFrom('bench-press', 'barbell-bench', 'row', 'squat'),
      planned: fc.constantFrom(undefined, 'bench-press', 'barbell-bench', 'row'),
    }),
    { maxLength: 30 },
  );
  /** Each set time differs, so the tie-break is the only thing choosing between rows of one date. */
  const rowsOf = (drawn: readonly { readonly date: string; readonly lift: string; readonly planned: string | undefined }[]) =>
    drawn.map(({ date, lift: name, planned }, i) => performance({ date, lift: name, sets: [lb(100, 8, i)], ...(planned === undefined || planned === name ? {} : { planned }) }));
  const book = liftBook([{ id: lift('bench-press'), name: 'Bench press', aliases: [lift('barbell-bench')] }]);

  it('answers last time and the swap hint the same as a scan of every row', async () => {
    await fc.assert(
      fc.asyncProperty(rowsArbitrary, fc.constantFrom('2030-03-02', '2030-03-03', '2030-03-04', '2030-03-05'), async (drawn, date) => {
        const rows = rowsOf(drawn);
        const { replica } = await setup();
        await put(replica, rows);
        const before = day(date);
        for (const name of ['bench-press', 'row', 'squat']) {
          const read = { lift: lift(name), book, before };
          const seeked = await lastTimesView(replica.read, book.members(lift(name)), before);
          expect(lastTimeOf({ ...read, rows: seeked })).toEqual(lastTimeOf({ ...read, rows }));
          expect(lastSwapAt({ ...read, rows: seeked })).toEqual(lastSwapAt({ ...read, rows }));
        }
        replica.close();
      }),
      { numRuns: 100 },
    );
  });

  it('reads a chart from a date: the lifts, what was done as a swap for them, and each row once', async () => {
    await fc.assert(
      fc.asyncProperty(rowsArbitrary, fc.constantFrom('2030-03-01', '2030-03-03', '2030-03-05'), async (drawn, from) => {
        const rows = rowsOf(drawn);
        const { replica } = await setup();
        await put(replica, rows);
        const members = book.members(lift('bench-press'));
        const expected = rows.filter((row) => row.date >= from && (members.includes(row.liftId) || (row.plannedLiftId !== undefined && members.includes(row.plannedLiftId))));
        expect(ids(await replica.read.performancesFrom(members, day(from)))).toEqual(ids(expected));
        replica.close();
      }),
      { numRuns: 100 },
    );
  });

  it('does not re-run the last-time read when a set is logged today, and does when an earlier day changes', async () => {
    // A live query only runs where Dexie found a global indexedDB, which Node has none of.
    Object.assign(Dexie.dependencies, { indexedDB: new IDBFactory(), IDBKeyRange });
    const { replica } = await setup();
    const today = day('2030-03-11');
    const older = performance({ date: '2030-03-04', lift: 'bench-press', sets: [lb(100, 8)] });
    await put(replica, [older]);

    let runs = 0;
    const lastTime = replica.live((r) => {
      runs++;
      return lastTimesView(r, [lift('bench-press')], today);
    });
    const seen: (readonly Performance[])[] = [];
    const stop = lastTime.subscribe((rows) => seen.push(rows));
    const todays: Performance[] = [];
    // Reads the day being logged, so it must re-run on the same commit the read above must ignore.
    const stopWitness = replica.live((r) => r.onDate('performance', today)).subscribe((rows) => {
      todays.length = 0;
      todays.push(...rows);
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await put(replica, [performance({ date: today, lift: 'bench-press', sets: [lb(110, 8, 1)] })]);
    await vi.waitFor(() => expect(todays).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);

    const corrected = { ...older, sets: [lb(105, 8)] };
    await put(replica, [corrected]);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([corrected]));
    expect(runs).toBe(2);
    stop();
    stopWitness();
  });
});

describe('schema upgrades', () => {
  it('opens a phone still on the first layout with its data intact and the barcode index built', async () => {
    const indexedDB = new IDBFactory();
    const v1 = new Dexie('upgrade', { indexedDB, IDBKeyRange });
    const [first] = SCHEMA_HISTORY;
    if (first === undefined) throw new Error('no schema history');
    v1.version(1).stores(first);
    const oats = { ...food(), barcodes: [Gtin.parse('0049000000443')] };
    const lunch = entry(newEntryId(), 640);
    await v1.table('food').put({ id: oats.id, doc: oats });
    await v1.table('entry').put({ id: lunch.id, doc: lunch });
    v1.close();

    const { replica } = await openReplica({ name: 'upgrade', indexedDB, IDBKeyRange });
    open.push(replica);
    expect(await replica.read.withBarcode(Gtin.parse('0049000000443'))).toEqual([oats]);
    expect(await replica.read.withBarcode(Gtin.parse('4006381333931'))).toEqual([]);
    expect(await replica.read.onDate('entry', lunch.date)).toEqual([lunch]);
    expect(await replica.read.all('goal')).toEqual([]);
  });

  it('takes a phone from the previous layout to this one with its food and outbox intact, and sync still works', async () => {
    const ctx = { now: at(1), userAgent: null };
    const server = openStore(':memory:');
    const clientId = newClientId();
    const oats = { ...food(), barcodes: [Gtin.parse('0049000000443')] };
    const synced = entry(newEntryId(), 300);
    const pending = entry(newEntryId(), 640);
    const deletedOffline = entry(newEntryId(), 120);
    const earlier = server.sync(request(clientId, [{ op: 'put', id: MutationId.parse(1), kind: 'food', docId: oats.id, doc: oats }, putEntry(2, synced), putEntry(3, deletedOffline)]), ctx);
    expect(earlier.rejected).toEqual([]);

    const indexedDB = new IDBFactory();
    const previous = new Dexie('upgrade', { indexedDB, IDBKeyRange });
    const layout = SCHEMA_HISTORY.at(-2);
    if (layout === undefined) throw new Error('no previous layout');
    previous.version(DB_VERSION - 1).stores(layout);
    expect(Object.keys(layout)).not.toContain('performance');
    await previous.table('food').put({ id: oats.id, doc: oats });
    await previous.table('entry').bulkPut([synced, pending].map((doc) => ({ id: doc.id, doc })));
    await previous.table('outbox').add({ mutationId: 4, op: 'put', kind: 'entry', docId: pending.id, doc: pending });
    await previous.table('outbox').add({ op: 'delete', kind: 'entry', docId: deletedOffline.id });
    await previous.table('meta').put({ key: 'sync', clientId, epoch: earlier.epoch, cursor: earlier.cursor });
    previous.close();

    const plan = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }]);
    const coach = newClientId();
    const coached = server.sync(request(coach, [{ op: 'put', id: MutationId.parse(1), kind: 'program', docId: plan.id, doc: plan }]), ctx);
    expect(coached.rejected).toEqual([]);

    const { replica, port } = await openReplica({ name: 'upgrade', indexedDB, IDBKeyRange, newId: () => 'never-used' });
    open.push(replica);
    expect(await replica.read.withBarcode(Gtin.parse('0049000000443'))).toEqual([oats]);
    expect(await replica.read.onDate('entry', pending.date)).toEqual(expect.arrayContaining([synced, pending]));

    const queued = await port.nextBatch(10);
    expect(queued).toMatchObject({ clientId, epoch: earlier.epoch, cursor: earlier.cursor });
    expect(queued.mutations).toMatchObject([
      { id: 4, op: 'put', kind: 'entry', docId: pending.id, doc: pending },
      { id: 5, op: 'delete', kind: 'entry', docId: deletedOffline.id },
    ]);
    const revBefore = server.stats().rev;

    await syncRounds(port, (req) => Promise.resolve(server.sync(req, ctx)));
    expect(await port.pendingCount()).toBe(0);
    expect(server.stats().rev, 'the two queued writes and nothing re-queued').toBe(revBefore + 2);
    const onServer = server.sync(request(newClientId(), []), ctx).changes;
    expect(onServer.find((c) => c.id === pending.id)?.doc).toEqual(pending);
    expect(onServer.find((c) => c.id === deletedOffline.id)?.doc).toBeNull();
    expect(await replica.read.programOn(plan.effectiveFrom)).toEqual(plan);

    const set = performance({ date: '2030-03-04', lift: 'bench-press', sets: [lb(100, 8)] });
    await replica.commit([{ op: 'put', kind: 'performance', doc: set }]);
    expect(await replica.read.lastPerformances([set.liftId], day('2030-03-05'))).toEqual([set]);
    await syncRounds(port, (req) => Promise.resolve(server.sync(req, ctx)));
    expect(await port.pendingCount()).toBe(0);
    expect(server.sync(request(newClientId(), []), ctx).changes.find((c) => c.id === set.id)?.doc).toEqual(set);
    server.close();
  });
});
