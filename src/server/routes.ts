/** The HTTP surface. Each handler parses its input, calls the store, and serializes the result. */
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Millis } from '../domain/ids.js';
import { SyncRequest, type Healthz } from '../protocol.js';
import { log } from './log.js';
import type { DocStore } from './store.js';

export interface AppDeps {
  readonly store: DocStore;
  /** The built PWA. Same origin as the API, so there is no CORS and the service worker scope is '/'. */
  readonly staticDir: string;
  readonly now: () => Millis;
}

export function buildApp({ store, staticDir, now }: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    log('request_failed', { method: c.req.method, path: c.req.path, error: err.message });
    return c.json({ error: 'internal error' }, 500);
  });

  app.post('/api/sync', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const req = SyncRequest.safeParse(body);
    if (!req.success) return c.json({ error: z.prettifyError(req.error) }, 400);
    return c.json(store.sync(req.data, { now: now(), userAgent: c.req.header('user-agent') ?? null }));
  });

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
