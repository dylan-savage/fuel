import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, deleteEntry, entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';

const ctx = { now: at(1), userAgent: null };
const stores: DocStore[] = [];
const open = (path = ':memory:', pageSize?: number) => {
  const store = openStore(path, pageSize === undefined ? {} : { pageSize });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe('DocStore.sync', () => {
  it('stores a pushed document and echoes it back with a revision', () => {
    const store = open();
    const doc = entry(newEntryId(), 420);
    const res = store.sync(request(newClientId(), [putEntry(1, doc)]), ctx);
    expect(res.lastMutationId).toBe(1);
    expect(res.changes).toEqual([{ kind: 'entry', id: doc.id, rev: 1, doc }]);
    expect(res.cursor).toBe(1);
    expect(res.more).toBe(false);
  });

  it('applies a replayed request only once', () => {
    const store = open();
    const client = newClientId();
    const req = request(client, [putEntry(1, entry(newEntryId(), 100)), putEntry(2, entry(newEntryId(), 200))]);
    store.sync(req, ctx);
    const replay = store.sync(req, ctx);
    expect(replay.lastMutationId).toBe(2);
    expect(store.stats().rev).toBe(2);
  });

  it('skips mutations at or below the last processed id but applies newer ones in the same batch', () => {
    const store = open();
    const client = newClientId();
    const first = entry(newEntryId(), 100);
    store.sync(request(client, [putEntry(1, first)]), ctx);
    const second = entry(newEntryId(), 200);
    const res = store.sync(request(client, [putEntry(1, { ...first, meal: 'dinner' }), putEntry(2, second)]), ctx);
    expect(res.changes.map((c) => c.doc)).toEqual([first, second]);
  });

  it('sends other clients only what is above their cursor', () => {
    const store = open();
    const a = newClientId();
    const one = entry(newEntryId(), 1);
    const two = entry(newEntryId(), 2);
    store.sync(request(a, [putEntry(1, one)]), ctx);
    const { epoch, cursor } = store.sync(request(newClientId(), []), ctx);
    store.sync(request(a, [putEntry(2, two)]), ctx);
    const res = store.sync(request(newClientId(), [], cursor, epoch), ctx);
    expect(res.changes.map((c) => c.id)).toEqual([two.id]);
  });

  it('turns a delete into a tombstone that other clients pull', () => {
    const store = open();
    const a = newClientId();
    const doc = entry(newEntryId(), 300);
    store.sync(request(a, [putEntry(1, doc), deleteEntry(2, doc.id)]), ctx);
    const res = store.sync(request(newClientId(), []), ctx);
    expect(res.changes).toEqual([{ kind: 'entry', id: doc.id, rev: 2, doc: null }]);
  });

  it('rejects an invalid document alone, returns the server copy, and counts it processed', () => {
    const store = open();
    const a = newClientId();
    const doc = entry(newEntryId(), 300);
    store.sync(request(a, [putEntry(1, doc)]), ctx);
    const broken = { ...putEntry(2, doc), doc: { ...doc, meal: 'brunch' } };
    const next = entry(newEntryId(), 50);
    const res = store.sync(request(a, [broken, putEntry(3, next)]), ctx);
    expect(res.lastMutationId).toBe(3);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.mutationId).toBe(2);
    expect(res.rejected[0]?.reason).toContain('meal');
    expect(res.rejected[0]?.current).toEqual({ kind: 'entry', id: doc.id, rev: 1, doc });
    expect(res.changes.map((c) => c.doc)).toEqual([doc, next]);
  });

  it('rejects a put whose document id differs from docId', () => {
    const store = open();
    const res = store.sync(request(newClientId(), [{ ...putEntry(1, entry(newEntryId(), 1)), docId: newEntryId() }]), ctx);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.kind).toBe('entry');
    expect(res.rejected[0]?.current).toBeNull();
    expect(res.changes).toEqual([]);
  });

  it('pages pulls and reports more until the last page', () => {
    const store = open(':memory:', 2);
    const client = newClientId();
    store.sync(request(client, [1, 2, 3, 4, 5].map((n) => putEntry(n, entry(newEntryId(), n)))), ctx);
    const pages: number[][] = [];
    let res = store.sync(request(newClientId(), []), ctx);
    pages.push(res.changes.map((c) => c.rev));
    while (res.more) {
      res = store.sync(request(newClientId(), [], res.cursor, res.epoch), ctx);
      pages.push(res.changes.map((c) => c.rev));
    }
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('pulls from zero when the client holds another epoch', () => {
    const store = open();
    const client = newClientId();
    store.sync(request(client, [putEntry(1, entry(newEntryId(), 1))]), ctx);
    const { epoch, cursor } = store.sync(request(client, []), ctx);
    store.rotateEpoch();
    const res = store.sync(request(client, [], cursor, epoch), ctx);
    expect(res.epoch).not.toBe(epoch);
    expect(res.changes).toHaveLength(1);
  });

  it('keeps documents and epoch across a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fuel-store-')), 'fuel.db');
    const first = open(path);
    const doc = entry(newEntryId(), 1);
    first.sync(request(newClientId(), [putEntry(1, doc)]), ctx);
    const { epoch } = first.stats();
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const reopened = open(path);
    expect(reopened.stats().epoch).toBe(epoch);
    expect(reopened.sync(request(newClientId(), []), ctx).changes.map((c) => c.doc)).toEqual([doc]);
  });
});

describe('DocStore.lookupCache', () => {
  it('returns the answer put for a source and key, and null for any other', () => {
    const { lookupCache } = open();
    const answer = { status: 200, body: { status: 1, product: { product_name: 'Oats' } }, fetchedAt: at(5) };
    lookupCache.put('off', '0049000000443', answer);
    expect(lookupCache.get('off', '0049000000443')).toEqual(answer);
    expect(lookupCache.get('usda', '0049000000443')).toBeNull();
    expect(lookupCache.get('off', '3017620422003')).toBeNull();
  });

  it('replaces the previous answer for the same source and key', () => {
    const { lookupCache } = open();
    lookupCache.put('off', '0049000000443', { status: 404, body: { status: 0 }, fetchedAt: at(1) });
    lookupCache.put('off', '0049000000443', { status: 200, body: { status: 1 }, fetchedAt: at(2) });
    expect(lookupCache.get('off', '0049000000443')).toEqual({ status: 200, body: { status: 1 }, fetchedAt: at(2) });
  });
});
