/**
 * The whole HTTP surface. Each handler parses its input with a protocol schema, calls one
 * module, and serializes the result. No business logic lives here.
 */
import { Hono } from 'hono';
import { todo } from '../todo.js';
import type { Millis } from '../domain/ids.js';
import type { AiParser } from './ai.js';
import type { FoodSources } from './foods.js';
import type { DocStore } from './store.js';

export interface AppDeps {
  readonly store: DocStore;
  readonly foods: FoodSources;
  /** Null when ANTHROPIC_API_KEY is absent; AI routes then answer 503 { error: 'ai_unconfigured' }. */
  readonly ai: AiParser | null;
  /** Built PWA (vite output). Served from the same origin, so there is no CORS and the service worker scope is '/'. */
  readonly staticDir: string;
  readonly now: () => Millis;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // SyncRequest -> SyncResponse. 400 { error } on a body that fails SyncRequest.
  app.post('/api/sync', () => todo(`sync via ${typeof deps.store.sync}`));

  // ?q=<2..80 chars>&limit=<1..50> -> FoodSearchResponse. Online-only path for the phone.
  app.get('/api/foods/search', () => todo('foods.search'));

  // :ref = gtin:<digits> | usda:<fdcId> -> LookupResponse. 400 on a bad ref.
  app.get('/api/foods/lookup/:ref', () => todo('foods.lookup'));

  // AiParseRequest -> AiParseResponse. Body limit 5 MB. Passes store.libraryFoods() for matching.
  app.post('/api/ai/parse', () => todo('ai.parse'));

  // HealthIngestRequest -> HealthIngestResponse. Always 200 with ok true or false, so the
  // Shortcut's single "ok is true" check covers every failure.
  app.post('/api/health/ingest', () => todo('health.ingest'));

  // -> Healthz. Used by the launchd smoke check and the PWA's "server reachable" probe.
  app.get('/healthz', () => todo('healthz'));

  // Static PWA: index.html, sw.js and manifest with Cache-Control no-cache; /assets/* hashed
  // and immutable; unknown non-/api paths fall back to index.html.
  app.get('*', () => todo(`static from ${deps.staticDir}`));

  return app;
}
