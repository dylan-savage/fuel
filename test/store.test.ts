import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type DocStore } from '../src/server/store.js';
import { at, deleteEntry, entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';
import { liftsBlock, program, slot } from './training.fixtures.js';

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

describe('the build a phone reports on sync', () => {
  const reported = (build: string) => ({ ...request(newClientId(), []), build });

  it('keeps the latest and when it arrived, and a sync without one leaves it alone', () => {
    const store = open();
    expect(store.stats().phoneBuild).toBeNull();
    store.sync(reported('abc-1'), { now: at(5), userAgent: null });
    expect(store.stats().phoneBuild).toEqual({ build: 'abc-1', at: 5 });
    store.sync(reported('def-2'), { now: at(6), userAgent: null });
    expect(store.stats().phoneBuild).toEqual({ build: 'def-2', at: 6 });
    store.sync(request(newClientId(), []), { now: at(7), userAgent: null });
    expect(store.stats().phoneBuild).toEqual({ build: 'def-2', at: 6 });
  });

  it('is no document: it takes no revision and no pull ever carries it', () => {
    const store = open();
    store.sync(reported('abc-1'), { now: at(5), userAgent: null });
    expect(store.stats().rev).toBe(0);
    expect(store.sync(request(newClientId(), []), ctx).changes).toEqual([]);
  });

  it('survives a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fuel-store-')), 'fuel.db');
    const first = open(path);
    first.sync(reported('abc-1'), { now: at(5), userAgent: null });
    first.close();
    stores.splice(stores.indexOf(first), 1);
    expect(open(path).stats().phoneBuild).toEqual({ build: 'abc-1', at: 5 });
  });
});

describe('the coach reads and writes', () => {
  const plan = (effectiveFrom = '2030-03-11') => program(effectiveFrom, [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }]);
  const coachCtx = { now: at(9) };

  it('lists the live documents of one kind with their revs, and nothing of another kind', () => {
    const store = open();
    const client = newClientId();
    const kept = entry(newEntryId(), 100);
    const deleted = entry(newEntryId(), 200);
    store.sync(request(client, [putEntry(1, deleted), putEntry(2, kept), deleteEntry(3, deleted.id)]), ctx);
    const version = plan();
    store.writeProgram(version, coachCtx);
    expect(store.liveDocs('entry')).toEqual([{ doc: kept, rev: 2 }]);
    expect(store.liveDocs('program')).toEqual([{ doc: version, rev: 4 }]);
    expect(store.liveDocs('session')).toEqual([]);
  });

  it('gives the newest rev of a kind, counting a tombstone, and is not moved by another kind', () => {
    const store = open();
    expect(store.highestRev('entry')).toBe(0);
    const doc = entry(newEntryId(), 100);
    store.sync(request(newClientId(), [putEntry(1, doc)]), ctx);
    store.writeProgram(plan(), coachCtx);
    expect(store.highestRev('entry')).toBe(1);
    expect(store.highestRev('program')).toBe(2);
    store.sync(request(newClientId(), [deleteEntry(1, doc.id)]), ctx);
    expect(store.highestRev('entry')).toBe(3);
    expect(store.highestRev('program')).toBe(2);
  });

  it('refuses to read a stored document the schema rejects, without saying what it holds', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fuel-store-')), 'fuel.db');
    const store = open(path);
    store.sync(request(newClientId(), [putEntry(1, entry(newEntryId(), 100))]), ctx);
    const raw = new Database(path);
    raw.prepare("UPDATE doc SET body = '{\"secret\":\"left knee\"}'").run();
    raw.close();
    expect(() => store.liveDocs('entry')).toThrow(/^the entry stored at rev 1 does not parse$/);
  });

  it('stamps the next rev across every kind, answers what it stored, and a phone pulls it', () => {
    const store = open();
    const client = newClientId();
    const first = store.sync(request(client, [putEntry(1, entry(newEntryId(), 100))]), ctx);
    const version = plan();
    expect(store.writeProgram(version, coachCtx)).toEqual({ doc: version, rev: 2 });
    expect(store.sync(request(client, [], first.cursor, first.epoch), ctx).changes).toEqual([{ kind: 'program', id: version.id, rev: 2, doc: version }]);
  });

  it('replaces a version in place under a new rev', () => {
    const store = open();
    store.writeProgram(plan(), coachCtx);
    const replaced = { ...plan(), weeklyMinimum: 4 };
    expect(store.writeProgram(replaced, coachCtx).rev).toBe(2);
    expect(store.liveDocs('program')).toEqual([{ doc: replaced, rev: 2 }]);
  });

  it('records the coach as the writer and when, and registers no client', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fuel-store-')), 'fuel.db');
    const store = open(path);
    store.writeProgram(plan(), coachCtx);
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare('SELECT written_by, written_at FROM doc').all()).toEqual([{ written_by: 'coach', written_at: 9 }]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM client').get()).toEqual({ n: 0 });
    raw.close();
  });
});

/** Every table as fuel.db held it before phones reported a build, frozen here on purpose. */
const SCHEMA_BEFORE_BUILDS = /* sql */ `
CREATE TABLE doc (
  kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL UNIQUE, body TEXT,
  written_by TEXT NOT NULL, written_at INTEGER NOT NULL, PRIMARY KEY (kind, id)
) STRICT;
CREATE TABLE client (
  id TEXT PRIMARY KEY, last_mutation_id INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, user_agent TEXT
) STRICT;
CREATE TABLE rejection (
  client_id TEXT NOT NULL, mutation_id INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL,
  mutation TEXT NOT NULL, PRIMARY KEY (client_id, mutation_id)
) STRICT;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE lookup_cache (
  source TEXT NOT NULL, key TEXT NOT NULL, fetched_at INTEGER NOT NULL, status INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY (source, key)
) STRICT;
`;

describe('a database file from before phones reported a build', () => {
  it('opens with its documents, epoch and client intact, then syncs and records a build', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fuel-store-')), 'fuel.db');
    const client = newClientId();
    const doc = entry(newEntryId(), 640);
    const existing = new Database(path);
    existing.pragma('journal_mode = WAL');
    existing.exec(SCHEMA_BEFORE_BUILDS);
    existing.prepare("INSERT INTO meta (key, value) VALUES ('epoch', 'e-before')").run();
    existing.prepare('INSERT INTO doc (kind, id, rev, body, written_by, written_at) VALUES (?, ?, 1, ?, ?, 1)').run('entry', doc.id, JSON.stringify(doc), client);
    existing.prepare('INSERT INTO client (id, last_mutation_id, first_seen_at, last_seen_at) VALUES (?, 7, 1, 1)').run(client);
    existing.close();

    const store = open(path);
    expect(store.stats()).toEqual({ epoch: 'e-before', rev: 1, phoneBuild: null });

    const next = entry(newEntryId(), 200);
    const replayed = store.sync({ ...request(client, [putEntry(7, next)], 0, 'e-before'), build: 'abc-1' }, ctx);
    expect(replayed.lastMutationId).toBe(7);
    expect(replayed.changes.map((c) => c.doc)).toEqual([doc]);
    const res = store.sync({ ...request(client, [putEntry(8, next)], 1, 'e-before'), build: 'abc-1' }, ctx);
    expect(res.changes).toEqual([{ kind: 'entry', id: next.id, rev: 2, doc: next }]);
    expect(store.stats()).toEqual({ epoch: 'e-before', rev: 2, phoneBuild: { build: 'abc-1', at: 1 } });
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
