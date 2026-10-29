import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { AiAnswer, AiError, Healthz, LookupResponse, SearchResponse, SyncResponse, type AiParseRequest } from '../src/protocol.js';
import { createAiParser, type AiParser } from '../src/server/ai.js';
import { createFoodSources } from '../src/server/foods.js';
import { createOffClient } from '../src/server/off.js';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import type { Fetch } from '../src/server/upstream.js';
import { BREAKFAST, breakfastReply, message, stubMessages } from './ai-replies.js';
import { at, entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';
import { recording, replay } from './recordings.js';

const staticDir = mkdtempSync(join(tmpdir(), 'fuel-static-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>fuel</title>');
writeFileSync(join(staticDir, 'sw.js'), 'self.skipWaiting()');
mkdirSync(join(staticDir, 'assets'));
writeFileSync(join(staticDir, 'assets', 'index-abc123.js'), 'console.log(1)');

const cokeRecording = recording('off', 'coca-cola');
const searchRecording = recording('off', 'search-greek-yogurt');
const recorded = replay(cokeRecording, recording('off', 'unknown'), searchRecording);
const USER_AGENT = 'fuel/test (single-user calorie tracker)';

const stores: DocStore[] = [];
afterAll(() => {
  for (const s of stores) s.close();
});

/** The app with Open Food Facts reached through `fetch` and USDA not configured. */
function appOver(fetch: Fetch, ai: AiParser | null = null) {
  const store = openStore(':memory:');
  stores.push(store);
  const off = createOffClient({
    productUrl: new URL(cokeRecording.request).origin,
    searchUrl: new URL(searchRecording.request).origin,
    userAgent: USER_AGENT,
    fetch,
    now: () => at(1),
  });
  const foods = createFoodSources({ off, usda: null, cache: store.lookupCache, now: () => at(1) });
  return { store, app: buildApp({ store, foods, ai, staticDir, now: () => at(1) }) };
}

const { store, app } = appOver(recorded.fetch);
const unreachable: Fetch = () => Promise.reject(new TypeError('fetch failed'));
const overloaded: Fetch = () => Promise.resolve(new Response('busy', { status: 503 }));

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

describe('GET /api/foods/lookup/:ref', () => {
  it('answers found with the candidate, asking Open Food Facts as fuel', async () => {
    const res = await app.request('/api/foods/lookup/gtin:0049000000443');
    expect(res.status).toBe(200);
    expect(LookupResponse.parse(await res.json())).toMatchObject({ kind: 'found', candidate: { name: 'Coca-Cola', unit: 'ml' } });
    expect(recorded.sent.at(-1)?.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('answers not_found for a product Open Food Facts does not know', async () => {
    const res = await app.request('/api/foods/lookup/gtin:0028400999991');
    expect(res.status).toBe(200);
    expect(LookupResponse.parse(await res.json())).toEqual({ kind: 'not_found' });
  });

  it.each(['gtin:123', 'gtin:0049000000444', 'usda:abc', 'nope'])('answers 400 to the ref %s', async (ref) => {
    expect((await app.request(`/api/foods/lookup/${ref}`)).status).toBe(400);
  });
});

describe('GET /api/foods/search', () => {
  it('answers the hits as a SearchResponse', async () => {
    const res = await app.request('/api/foods/search?q=greek%20yogurt');
    expect(res.status).toBe(200);
    const { hits } = SearchResponse.parse(await res.json());
    expect(hits).toHaveLength(20);
    expect(hits[0]?.candidate).toMatchObject({ name: 'Nonfat Greek Yogurt', brand: 'Chobani' });
  });

  it.each(['', '?q=', '?q=%20%20', `?q=${'x'.repeat(101)}`])('answers 400 to the query "%s"', async (query) => {
    expect((await app.request(`/api/foods/search${query}`)).status).toBe(400);
  });
});

describe.each([
  ['unreachable', unreachable],
  ['answering 503', overloaded],
])('with Open Food Facts %s', (_, fetch) => {
  const failing = appOver(fetch).app;

  it('answers a lookup with 502', async () => {
    expect((await failing.request('/api/foods/lookup/gtin:0049000000443')).status).toBe(502);
  });

  it('answers a search with 502', async () => {
    expect((await failing.request('/api/foods/search?q=greek%20yogurt')).status).toBe(502);
  });
});

describe('POST /api/ai/parse', () => {
  const parse = (target: typeof app, body: unknown) =>
    target.request('/api/ai/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const withModel = (reply: Parameters<typeof stubMessages>[0]) =>
    appOver(recorded.fetch, createAiParser({ messages: stubMessages(reply), model: 'claude-opus-5-5' })).app;
  const breakfast: AiParseRequest = { kind: 'text', text: BREAKFAST, foods: [] };

  it('answers 503 ai_unconfigured without an API key, whatever the body', async () => {
    for (const body of [breakfast, { nope: true }]) {
      const res = await parse(app, body);
      expect(res.status).toBe(503);
      expect(AiError.parse(await res.json())).toEqual({ error: 'ai_unconfigured' });
    }
  });

  it('answers the drafts as an AiAnswer', async () => {
    const res = await parse(withModel(breakfastReply(null)), breakfast);
    expect(res.status).toBe(200);
    expect(AiAnswer.parse(await res.json())).toMatchObject({ kind: 'drafts', drafts: [{ name: 'Egg' }, { name: 'Sourdough toast' }, { name: 'Butter' }, { name: 'Overnight oats' }] });
  });

  it('answers a refusal and a timeout with their reasons', async () => {
    const refused = message({ stop_reason: 'refusal' });
    const timedOut = () => {
      throw new Anthropic.APIConnectionTimeoutError();
    };
    for (const [reply, status, error] of [
      [refused, 422, 'ai_refused'],
      [timedOut, 504, 'ai_timeout'],
    ] as const) {
      const res = await parse(withModel(reply), breakfast);
      expect(res.status).toBe(status);
      expect(AiError.parse(await res.json())).toEqual({ error });
    }
  });

  it('answers 400 to a body that is not an AiParseRequest, without calling the model', async () => {
    const messages = stubMessages(breakfastReply(null));
    const configured = appOver(recorded.fetch, createAiParser({ messages, model: 'claude-opus-5-5' })).app;
    for (const body of [{ kind: 'text', text: 'x', foods: [] }, { kind: 'photo', subject: 'menu', mediaType: 'image/jpeg', base64: 'AA', foods: [] }]) {
      expect((await parse(configured, body)).status).toBe(400);
    }
    expect(messages.sent).toEqual([]);
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
