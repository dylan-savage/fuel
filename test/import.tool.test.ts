import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { newClientId, request } from './fixtures.js';
import { ms, noFoods, noonOf } from './training.fixtures.js';

// Each unreachable case waits out the tool's one retry in a real child process.
vi.setConfig({ testTimeout: 20_000 });

const TOOL = fileURLToPath(new URL('../scripts/import-history.mjs', import.meta.url));

const MONDAY = '2030-03-04';
const FILE = {
  capturedAt: '2030-03-20',
  cutover: '2030-04-01',
  dateAssumption: 'Monday plus the planned weekday.',
  names: { 'Bench press': 'bench-press' },
  weeks: [
    {
      monday: MONDAY,
      days: [{ label: 'Mon, Push', key: 'push', weekday: 1, date: MONDAY, pageId: 'page-1', pageEditedAt: '2030-03-04T18:00:00.000Z', morningWeightLb: 180, exercises: [{ done: 'Bench press', sets: [{ load: { kind: 'weight', amount: 100, unit: 'lb' }, reps: { kind: 'total', reps: 10 } }] }], skipped: [] }],
    },
  ],
  progress: [{ entry: 'Bench press, Mar 4', exercise: 'Bench press', day: 'Mon, Push', monday: MONDAY, topLb: 100, volume: 1000, e1rm: 133.33, reps: '10', keyLift: false }],
  weekRows: [{ week: 'Week of Mar 4', monday: MONDAY, current: false, sessionsDone: 1, notes: null }],
  bodyWeight: [{ entry: 'Mon Mar 4', date: MONDAY, lb: 180 }],
  waivers: [],
};

interface Stoppable {
  close(callback: () => void): unknown;
}
const stop = (server: Stoppable) =>
  new Promise<void>((done) => {
    server.close(done);
  });

const cleanups: (() => Promise<void> | void)[] = [];
let scratch: string;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  scratch = mkdtempSync(join(tmpdir(), 'fuel-import-tool-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function tool(args: readonly string[], env: Readonly<Record<string, string>>) {
  return new Promise<{ readonly exit: number; readonly stdout: string; readonly line: unknown }>((done) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: scratch, env: { PATH: process.env.PATH ?? '', HOME: scratch, ...env } }, (err, stdout) => {
      const exit = err === null ? 0 : Number(err.code);
      const first = stdout.split('\n')[0] ?? '';
      done({ exit, stdout, line: first === '' ? null : JSON.parse(first) });
    });
  });
}

function fileWith(contents: unknown = FILE): string {
  const path = join(scratch, 'history.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

/** A real store and server on a throwaway port. */
async function realServer(options: { readonly phone?: boolean } = {}) {
  const store: DocStore = openStore(join(scratch, 'fuel.db'));
  if (options.phone ?? true) store.sync({ ...request(newClientId(), []), build: 'abc-1' }, { now: ms(77), userAgent: null });
  const app = buildApp({ store, foods: noFoods, ai: null, staticDir: '.', now: () => noonOf('2030-03-20') });
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((done) => {
    const started: ServerType = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      done({ server: started, port: info.port });
    });
  });
  cleanups.push(async () => {
    await stop(server);
    store.close();
  });
  return { store, app, env: { FUEL_URL: `http://127.0.0.1:${port}` } };
}

async function fakeServer(listener: RequestListener) {
  const server: HttpServer = createHttpServer(listener);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return stop(server);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { FUEL_URL: `http://127.0.0.1:${address.port}` };
}

describe('what the tool depends on', () => {
  it('imports only node builtins, so a deploy removing dist cannot crash it', () => {
    const imports = [...readFileSync(TOOL, 'utf8').matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].map((match) => match[1] ?? match[2]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !name?.startsWith('node:'))).toEqual([]);
  });
});

describe('import-history.mjs against a real server', () => {
  it('exits 0 on a landing, printing one line, and a re-run writes nothing', async () => {
    const { env, store } = await realServer();
    const first = await tool([fileWith()], env);
    expect(first.exit).toBe(0);
    expect(first.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(first.line).toMatchObject({ status: 'imported', written: { session: 1, performance: 1, weighIn: 0 } });
    const rev = store.stats().rev;
    const second = await tool([fileWith()], env);
    expect(second.exit).toBe(0);
    expect(second.line).toMatchObject({ status: 'imported', written: { session: 0, performance: 0, weighIn: 0 }, unchanged: { session: 1, performance: 1 } });
    expect(store.stats().rev).toBe(rev);
  });

  it('exits 0 on a clean dry run, writing nothing', async () => {
    const { env, store } = await realServer();
    const { exit, line } = await tool([fileWith(), '--dry-run'], env);
    expect(exit).toBe(0);
    expect(line).toMatchObject({ status: 'dry-run', written: { session: 1, performance: 1 }, targetShift: { withOlder: { largest: null } } });
    expect(store.stats().rev).toBe(0);
  });

  it('writes weigh-ins only under --weigh-ins', async () => {
    const { env, store } = await realServer();
    expect(await tool([fileWith()], env)).toMatchObject({ line: { written: { weighIn: 0 } } });
    expect(store.liveDocs('weighIn')).toEqual([]);
    expect(await tool([fileWith(), '--weigh-ins'], env)).toMatchObject({ exit: 0, line: { written: { weighIn: 1 }, weighIns: { included: true } } });
    expect(store.liveDocs('weighIn')).toHaveLength(1);
  });

  it('dry-runs with both flags together', async () => {
    const { env, store } = await realServer();
    expect(await tool([fileWith(), '--dry-run', '--weigh-ins'], env)).toMatchObject({ exit: 0, line: { status: 'dry-run', written: { weighIn: 1 } } });
    expect(store.stats().rev).toBe(0);
  });

  it('exits 3 when conflicts are listed, the dry run too, because the rest is not the whole story', async () => {
    const { env, store, app } = await realServer();
    await tool([fileWith()], env);
    const [session] = store.liveDocs('session');
    if (session === undefined) throw new Error('no session');
    const edited = { ...session.doc, note: 'Edited on the phone.' };
    await app.request('/api/sync', { method: 'POST', body: JSON.stringify({ ...request(newClientId(), []), mutations: [{ op: 'put', id: 1, kind: 'session', docId: edited.id, doc: edited }] }) });
    const conflict = { status: 'imported', conflicts: [{ kind: 'session', id: edited.id }] };
    expect(await tool([fileWith()], env)).toMatchObject({ exit: 3, line: conflict });
    expect(await tool([fileWith(), '--dry-run'], env)).toMatchObject({ exit: 3, line: { ...conflict, status: 'dry-run' } });
  });

  it.each<[string, unknown, string]>([
    ['a misspelled field', { ...FILE, cutovr: '2030-04-01' }, 'invalid'],
    ['a file that is not JSON', '{"weeks": ', 'invalid'],
    ['a disagreement with Progress', { ...FILE, progress: [{ ...FILE.progress[0], volume: 1 }] }, 'unreconciled'],
    ['a session dated at its cutover', { ...FILE, cutover: MONDAY }, 'past_cutover'],
  ])('exits 2 on %s and writes nothing', async (_name, contents, status) => {
    const { env, store } = await realServer();
    const { exit, line } = await tool([fileWith(contents)], env);
    expect(exit).toBe(2);
    expect(line).toMatchObject({ status });
    expect(store.stats().rev).toBe(0);
  });

  it('exits 5 while no phone has reported a build', async () => {
    const { env, store } = await realServer({ phone: false });
    const { exit, line } = await tool([fileWith()], env);
    expect(exit).toBe(5);
    expect(line).toEqual({ status: 'phone_behind' });
    expect(store.stats().rev).toBe(0);
    expect(await tool([fileWith(), '--dry-run'], env)).toMatchObject({ exit: 0, line: { status: 'dry-run', phoneBehind: true } });
  });
});

describe('import-history.mjs before it asks anything', () => {
  it('exits 1 on a missing file, a misspelled flag and a stray argument, sending nothing', async () => {
    const seen = { requests: 0 };
    const env = await fakeServer((_req, res) => {
      seen.requests += 1;
      res.end('{}');
    });
    const file = fileWith();
    expect(await tool([join(scratch, 'nothing.json')], env)).toMatchObject({ exit: 1, line: { status: 'unreadable' } });
    expect((await tool([file, '--dryrun'], env)).exit).toBe(1);
    expect((await tool([file, file], env)).exit).toBe(1);
    expect((await tool([], env)).exit).toBe(1);
    expect(seen.requests).toBe(0);
  });
});

describe('import-history.mjs on odd answers', () => {
  it.each<[string, number, string]>([
    ['the app shell from a static fallback', 200, '<!doctype html><title>fuel</title>'],
    ['JSON with no status', 200, '{"ok":true}'],
    ['a status it has never heard of', 200, '{"status":"landed-probably"}'],
    ['imported with no counts', 200, '{"status":"imported"}'],
    ['imported under an error code', 500, '{"status":"imported","digest":"","written":{},"unchanged":{},"conflicts":[],"orphans":[],"weighIns":{}}'],
    ['a refusal under a 200', 200, '{"status":"invalid","problems":[]}'],
    ['a route an older server does not have', 404, '{"error":"not found"}'],
    ['an empty answer', 200, ''],
  ])('never exits 0 on %s', async (_name, http, answer) => {
    const env = await fakeServer((_req, res) => {
      res.statusCode = http;
      res.end(answer);
    });
    const { exit, line } = await tool([fileWith()], env);
    expect(exit).toBe(1);
    expect(line).toEqual({ status: 'unexpected', http });
  });

  it('exits 4 when the server is down, after one retry', async () => {
    const closed = await fakeServer((_req, res) => {
      res.end();
    });
    for (const cleanup of cleanups.splice(0)) await cleanup();
    const { exit, line } = await tool([fileWith()], closed);
    expect(exit).toBe(4);
    expect(line).toEqual({ status: 'unreachable', url: closed.FUEL_URL });
  });
});
