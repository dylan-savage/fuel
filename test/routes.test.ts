import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Healthz, SyncResponse } from '../src/protocol.js';
import { buildApp } from '../src/server/routes.js';
import { openStore } from '../src/server/store.js';
import { at, entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';

const staticDir = mkdtempSync(join(tmpdir(), 'fuel-static-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>fuel</title>');
writeFileSync(join(staticDir, 'sw.js'), 'self.skipWaiting()');
mkdirSync(join(staticDir, 'assets'));
writeFileSync(join(staticDir, 'assets', 'index-abc123.js'), 'console.log(1)');

const store = openStore(':memory:');
const app = buildApp({ store, staticDir, now: () => at(1) });
afterAll(() => store.close());

const post = (body: unknown) =>
  app.request('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/sync', () => {
  it('applies a push and answers a parseable SyncResponse', async () => {
    const doc = entry(newEntryId(), 640);
    const res = await post(request(newClientId(), [putEntry(1, doc)]));
    expect(res.status).toBe(200);
    const body = SyncResponse.parse(await res.json());
    expect(body.changes.map((c) => c.doc)).toContainEqual(doc);
  });

  it('answers 400 to a body that is not a SyncRequest', async () => {
    const res = await post({ clientId: 'nope', mutations: [] });
    expect(res.status).toBe(400);
  });

  it('answers 400 to mutation ids out of order', async () => {
    const res = await post(request(newClientId(), [putEntry(2, entry(newEntryId(), 1)), putEntry(1, entry(newEntryId(), 2))]));
    expect(res.status).toBe(400);
  });
});

describe('GET /healthz', () => {
  it('reports the epoch and revision', async () => {
    const body = Healthz.parse(await (await app.request('/healthz')).json());
    expect(body.epoch).toBe(store.stats().epoch);
  });
});

describe('static PWA', () => {
  it('serves index.html and sw.js with no-cache', async () => {
    for (const path of ['/', '/sw.js']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves hashed assets as immutable', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to the shell for app paths but not for missing files', async () => {
    expect(await (await app.request('/today')).text()).toContain('<title>fuel</title>');
    expect((await app.request('/assets/gone-123.js')).status).toBe(404);
  });

  it('answers unknown API paths with 404', async () => {
    expect((await app.request('/api/nope')).status).toBe(404);
  });
});
