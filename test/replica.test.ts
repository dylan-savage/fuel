import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidDocument, openReplica, type Replica } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { Gtin } from '../src/domain/food.js';
import { SCHEMA_HISTORY } from '../src/domain/kinds.js';
import { ClientId, MutationId, type SyncReply } from '../src/protocol.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, entry, food, newClientId, newEntryId, putEntry, request, rev } from './fixtures.js';

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
});
