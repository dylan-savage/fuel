import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidDocument, openReplica, type Replica } from '../src/client/replica.js';
import { Gtin } from '../src/domain/food.js';
import { SCHEMA_HISTORY } from '../src/domain/kinds.js';
import { MutationId, type SyncReply } from '../src/protocol.js';
import { entry, food, newEntryId, rev } from './fixtures.js';

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
