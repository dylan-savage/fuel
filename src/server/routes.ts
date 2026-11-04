/** The HTTP surface. Each handler parses its input, calls into AppDeps, and serializes the result. */
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { Millis } from '../domain/ids.js';
import {
  AiParseRequest,
  parseRef,
  SyncRequest,
  type AiAnswer,
  type AiError,
  type AiFailure,
  type Healthz,
  type LookupResponse,
  type SearchResponse,
} from '../protocol.js';
import type { AiParser } from './ai.js';
import type { FoodSources } from './foods.js';
import { mountImport } from './import.js';
import { log } from './log.js';
import type { DocStore } from './store.js';
import { mountTrain } from './train.js';
import { UpstreamError } from './upstream.js';

export interface AppDeps {
  readonly store: DocStore;
  readonly foods: FoodSources;
  readonly ai: AiParser | null;
  /** The built PWA. Same origin as the API, so there is no CORS and the service worker scope is '/'. */
  readonly staticDir: string;
  readonly now: () => Millis;
}

const SEARCH_LIMIT = 20;
const SearchQuery = z.string().trim().min(1).max(100);

const AI_STATUS = {
  ai_unconfigured: 503,
  ai_unavailable: 502,
  ai_timeout: 504,
  ai_refused: 422,
  ai_unreadable: 502,
  ai_nothing_found: 422,
} as const satisfies Readonly<Record<AiFailure, ContentfulStatusCode>>;

const aiError = (error: AiFailure): AiError => ({ error });

export function buildApp({ store, foods, ai, staticDir, now }: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const fields = { method: c.req.method, path: c.req.path, error: err.message };
    if (err instanceof UpstreamError) {
      log('upstream_failed', fields);
      return c.json({ error: 'food source unavailable' }, 502);
    }
    log('request_failed', fields);
    return c.json({ error: 'internal error' }, 500);
  });

  app.post('/api/sync', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const req = SyncRequest.safeParse(body);
    if (!req.success) return c.json({ error: z.prettifyError(req.error) }, 400);
    return c.json(store.sync(req.data, { now: now(), userAgent: c.req.header('user-agent') ?? null }));
  });

  app.get('/api/foods/lookup/:ref', async (c) => {
    const ref = parseRef(c.req.param('ref'));
    if (ref === null) return c.json({ error: 'expected gtin:<13 digits> or usda:<fdcId>' }, 400);
    return c.json((await foods.lookup(ref)) satisfies LookupResponse);
  });

  app.get('/api/foods/search', async (c) => {
    const q = SearchQuery.safeParse(c.req.query('q') ?? '');
    if (!q.success) return c.json({ error: 'q must be 1 to 100 characters' }, 400);
    return c.json({ hits: await foods.search(q.data, SEARCH_LIMIT) } satisfies SearchResponse);
  });

  app.post('/api/ai/parse', bodyLimit({ maxSize: 6 * 1024 * 1024 }), async (c) => {
    if (ai === null) return c.json(aiError('ai_unconfigured'), AI_STATUS.ai_unconfigured);
    const body: unknown = await c.req.json().catch(() => undefined);
    const req = AiParseRequest.safeParse(body);
    if (!req.success) return c.json({ error: z.prettifyError(req.error) }, 400);
    const outcome = await ai.parse(req.data);
    return outcome.ok ? c.json(outcome.answer satisfies AiAnswer) : c.json(aiError(outcome.reason), AI_STATUS[outcome.reason]);
  });

  mountTrain(app, { store, now });
  mountImport(app, { store, now });

  app.get('/healthz', (c) => c.json({ ok: true, ...store.stats() } satisfies Healthz));

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // Hashed build output never changes under its name. Everything else, the shell and sw.js
  // included, must revalidate so a deploy reaches the phone.
  app.use('*', async (c, next) => {
    c.header('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    await next();
  });
  app.use('*', serveStatic({ root: staticDir }));
  app.get('*', async (c, next) => {
    const isFile = c.req.path.split('/').at(-1)?.includes('.') ?? false;
    if (isFile) return next();
    return serveStatic({ root: staticDir, path: 'index.html' })(c, next);
  });

  return app;
}
