import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { openReplica, type Replica } from '../src/client/replica.js';
import { Gtin } from '../src/domain/food.js';
import { SCHEMA_HISTORY } from '../src/domain/kinds.js';
import { MutationId, type SyncResponse } from '../src/protocol.js';
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

const response = (fields: Partial<SyncResponse>): SyncResponse => ({
  epoch: 'e1',
  lastMutationId: 1,
  rejected: [],
  changes: [],
  cursor: rev(0),
  more: false,
  ...fields,
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

  it('refuses a pulled document it cannot parse and rolls back the whole response', async () => {
    const { replica, port } = await setup();
    await replica.commit([{ op: 'put', kind: 'entry', doc: entry(newEntryId(), 1) }]);
    const bad = response({ lastMutationId: 1, changes: [{ kind: 'entry', id: 'x', rev: rev(1), doc: { id: 'x' } }] });
    await expect(port.apply(bad)).rejects.toThrow('cannot read');
    expect(await port.pendingCount()).toBe(1);
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
