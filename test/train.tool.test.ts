import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { snapshotOf } from '../src/domain/coach.js';
import { TrainingNoteId } from '../src/domain/ids.js';
import { Muscle } from '../src/domain/lifts.js';
import { ProgramDraft, Report, type Program } from '../src/domain/program.js';
import { isRecord } from '../src/domain/strict.js';
import { PublishAnswer } from '../src/protocol.js';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { newClientId, request } from './fixtures.js';
import { T0, day, dayKey, lb, lift, liftsBlock, minutes, ms, noFoods, noonOf, performance, program, session, slot, slotId } from './training.fixtures.js';

// Each unreachable case waits out the tool's one retry in a real child process.
vi.setConfig({ testTimeout: 20_000 });

const TOOL = fileURLToPath(new URL('../scripts/train.mjs', import.meta.url));

const version = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3, { cue: 'Elbows in' })])] }]);

function draftOf({ id: _id, publishedAt: _publishedAt, ...rest }: Program, effectiveFrom: string): ProgramDraft {
  return { ...rest, effectiveFrom: day(effectiveFrom), changes: [] };
}

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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fuel-tool-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The tool as a child process with only the environment this test gives it, never the default URL or directory. */
function tool(args: readonly string[], env: Readonly<Record<string, string>>) {
  return new Promise<{ readonly exit: number; readonly stdout: string; readonly line: unknown }>((done) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: scratch, env: { PATH: process.env.PATH ?? '', HOME: scratch, ...env } }, (err, stdout) => {
      const exit = err === null ? 0 : Number(err.code);
      const first = stdout.split('\n')[0] ?? '';
      done({ exit, stdout, line: first === '' ? null : JSON.parse(first) });
    });
  });
}

const Printed = z.looseObject({ status: z.string() });

/** A real store and server on a throwaway port. */
async function realServer(options: { readonly phone?: boolean; readonly seeded?: boolean } = {}) {
  const store: DocStore = openStore(join(scratch, 'fuel.db'));
  if (options.phone ?? true) store.sync({ ...request(newClientId(), []), build: 'abc-1' }, { now: ms(77), userAgent: null });
  if (options.seeded ?? true) store.writeProgram(version, { now: ms(1) });
  const app = buildApp({ store, foods: noFoods, ai: null, staticDir: '.', now: () => noonOf('2030-03-10') });
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((done) => {
    const started: ServerType = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      done({ server: started, port: info.port });
    });
  });
  cleanups.push(async () => {
    await stop(server);
    store.close();
  });
  const env = { FUEL_URL: `http://127.0.0.1:${port}`, FUEL_COACH_DIR: join(scratch, 'coach') };
  const file = (name: string, contents: unknown) => {
    const path = join(scratch, name);
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return path;
  };
  return { store, env, file };
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
  return { FUEL_URL: `http://127.0.0.1:${address.port}`, FUEL_COACH_DIR: join(scratch, 'coach') };
}

/** Accepts and hangs up on every connection, which fetch sees as a network error. */
async function hangingUp() {
  const seen = { connections: 0 };
  const server: TcpServer = createTcpServer((socket) => {
    seen.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  cleanups.push(() => stop(server));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { seen, env: { FUEL_URL: `http://127.0.0.1:${address.port}`, FUEL_COACH_DIR: join(scratch, 'coach') } };
}

describe('what the tool depends on', () => {
  it('imports only node builtins, so a deploy removing dist cannot crash it', () => {
    const imports = [...readFileSync(TOOL, 'utf8').matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].map((match) => match[1] ?? match[2]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !name?.startsWith('node:'))).toEqual([]);
  });
});

describe('train.mjs read', () => {
  it('writes the snapshot and an editable draft privately, and prints one line', async () => {
    const { env, store } = await realServer();
    const { exit, stdout, line } = await tool(['read'], env);
    expect(exit).toBe(0);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    const basedOnRev = store.highestRev('program');
    const snapshotFile = join(env.FUEL_COACH_DIR, 'snapshot.json');
    const draftFile = join(env.FUEL_COACH_DIR, 'draft.json');
    expect(line).toEqual({ status: 'read', snapshot: snapshotFile, draft: draftFile, basedOnRev });
    expect(z.looseObject({ basedOnRev: z.number(), targetMonday: z.string() }).parse(JSON.parse(readFileSync(snapshotFile, 'utf8')))).toMatchObject({ basedOnRev, targetMonday: '2030-03-11' });
    const { basedOnRev: echoed, ...draft } = z.looseObject({ basedOnRev: z.number() }).parse(JSON.parse(readFileSync(draftFile, 'utf8')));
    expect(echoed).toBe(basedOnRev);
    expect(ProgramDraft.parse(draft).effectiveFrom).toBe('2030-03-11');
    expect(statSync(snapshotFile).mode & 0o777).toBe(0o600);
    expect(statSync(draftFile).mode & 0o777).toBe(0o600);
    expect(statSync(env.FUEL_COACH_DIR).mode & 0o777).toBe(0o700);
  });

  it('defaults to the coach directory beside the database', async () => {
    const { env } = await realServer();
    const { exit, line } = await tool(['read'], { FUEL_URL: env.FUEL_URL });
    expect(exit).toBe(0);
    expect(line).toMatchObject({ draft: join(scratch, 'Library/Application Support/fuel/coach/draft.json') });
  });

  it('writes a draft holding only the rev before the first version, which a publish names as incomplete', async () => {
    const { env } = await realServer({ seeded: false });
    expect((await tool(['read'], env)).exit).toBe(0);
    expect(JSON.parse(readFileSync(join(env.FUEL_COACH_DIR, 'draft.json'), 'utf8'))).toEqual({ basedOnRev: 0 });
    const { exit, line } = await tool(['publish', join(env.FUEL_COACH_DIR, 'draft.json')], env);
    expect(exit).toBe(2);
    expect(z.looseObject({ problems: z.array(z.looseObject({ path: z.string() })) }).parse(line).problems.map((p) => p.path)).toContain('effectiveFrom');
  });

  describe('refuses a directory in a git checkout', () => {
    const checkout = () => {
      const root = join(scratch, 'checkout');
      mkdirSync(join(root, '.git'), { recursive: true });
      return root;
    };

    it('at any depth, creating nothing and asking the server nothing', async () => {
      const seen = { requests: 0 };
      const { FUEL_URL } = await fakeServer((_req, res) => {
        seen.requests += 1;
        res.end('{}');
      });
      const dir = join(checkout(), 'a', 'b');
      const { exit, line } = await tool(['read'], { FUEL_URL, FUEL_COACH_DIR: dir });
      expect(exit).toBe(1);
      expect(line).toMatchObject({ status: 'refused', dir });
      expect(existsSync(join(scratch, 'checkout', 'a'))).toBe(false);
      expect(seen.requests).toBe(0);
    });

    it('in a worktree, where .git is a file', async () => {
      const root = join(scratch, 'worktree');
      mkdirSync(root);
      writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
      expect(Printed.parse((await tool(['read'], { FUEL_COACH_DIR: join(root, 'coach'), FUEL_URL: 'http://127.0.0.1:1' })).line).status).toBe('refused');
    });

    it('through a symlink that leads into one', async () => {
      const inside = join(checkout(), 'sub');
      mkdirSync(inside);
      const link = join(scratch, 'innocent');
      symlinkSync(inside, link);
      const { exit, line } = await tool(['read'], { FUEL_COACH_DIR: join(link, 'coach'), FUEL_URL: 'http://127.0.0.1:1' });
      expect(exit).toBe(1);
      expect(Printed.parse(line).status).toBe('refused');
    });
  });
});

describe('train.mjs publish', () => {
  it('exits 0 on landing and on repeating, with the server stating each', async () => {
    const { env, file, store } = await realServer();
    const draftFile = file('draft.json', { basedOnRev: store.highestRev('program'), ...draftOf(version, '2030-03-11') });
    const first = await tool(['publish', draftFile], env);
    expect(first.exit).toBe(0);
    expect(first.line).toEqual({ status: 'published', id: 'p:2030-03-11', rev: store.highestRev('program') });
    const rev = store.stats().rev;
    const second = await tool(['publish', draftFile], env);
    expect(second.exit).toBe(0);
    expect(second.line).toEqual({ status: 'unchanged', id: 'p:2030-03-11', rev });
    expect(store.stats().rev).toBe(rev);
  });

  it('exits 0 on a dry run, printing the diff and writing nothing', async () => {
    const { env, file, store } = await realServer();
    const rev = store.stats().rev;
    const { exit, line } = await tool(['publish', file('draft.json', { basedOnRev: store.highestRev('program'), ...draftOf(version, '2030-03-11') }), '--dry-run'], env);
    expect(exit).toBe(0);
    expect(line).toEqual({ status: 'dry-run', id: 'p:2030-03-11', diff: [], phoneBehind: false });
    expect(store.stats().rev).toBe(rev);
  });

  it('exits 2 on an invalid draft and on a file that is not JSON', async () => {
    const { env, file, store } = await realServer();
    const bad = await tool(['publish', file('bad.json', { basedOnRev: store.highestRev('program'), ...draftOf(version, '2030-03-11'), sessions: [] })], env);
    expect(bad.exit).toBe(2);
    expect(bad.line).toMatchObject({ status: 'invalid', problems: [{ code: 'unknown-field', path: 'sessions' }] });
    const broken = await tool(['publish', file('broken.json', '{"basedOnRev": ')], env);
    expect(broken.exit).toBe(2);
    expect(broken.line).toMatchObject({ status: 'invalid', problems: [{ path: '(body)' }] });
  });

  it('exits 3 on a frozen version and on a stale read', async () => {
    const { env, file, store } = await realServer();
    const read = store.highestRev('program');
    const frozen = await tool(['publish', file('frozen.json', { basedOnRev: read, ...draftOf(version, '2030-03-04'), notes: [{ text: 'Rewriting history' }] })], env);
    expect(frozen.exit).toBe(3);
    expect(frozen.line).toMatchObject({ status: 'frozen', earliestEffectiveFrom: '2030-03-10' });
    await tool(['publish', file('moved.json', { basedOnRev: read, ...draftOf(version, '2030-03-11') })], env);
    const stale = await tool(['publish', file('stale.json', { basedOnRev: read, ...draftOf(version, '2030-03-18') })], env);
    expect(stale.exit).toBe(3);
    expect(stale.line).toMatchObject({ status: 'stale', basedOnRev: read });
  });

  it('exits 5 while no phone has reported a build', async () => {
    const { env, file, store } = await realServer({ phone: false });
    const { exit, line } = await tool(['publish', file('draft.json', { basedOnRev: store.highestRev('program'), ...draftOf(version, '2030-03-11') })], env);
    expect(exit).toBe(5);
    expect(line).toEqual({ status: 'phone_behind' });
  });

  it('exits 1 on a missing file and a misspelled flag, sending nothing', async () => {
    const seen = { requests: 0 };
    const env = await fakeServer((_req, res) => {
      seen.requests += 1;
      res.end('{}');
    });
    const draftFile = join(scratch, 'draft.json');
    expect((await tool(['publish', draftFile], env)).exit).toBe(1);
    writeFileSync(draftFile, '{}');
    expect((await tool(['publish', draftFile, '--dryrun'], env)).exit).toBe(1);
    expect((await tool(['publish'], env)).exit).toBe(1);
    expect((await tool(['nonsense'], env)).exit).toBe(1);
    expect(seen.requests).toBe(0);
  });

  it('treats a hang-up as a network error: once more, then exit 4, and the retry can land', async () => {
    const draftFile = join(scratch, 'draft.json');
    writeFileSync(draftFile, '{}');
    const { seen, env } = await hangingUp();
    const { exit, line } = await tool(['publish', draftFile], env);
    expect(exit).toBe(4);
    expect(line).toEqual({ status: 'unreachable', url: env.FUEL_URL });
    expect(seen.connections).toBe(2);

    const attempts = { n: 0 };
    const flaky = await fakeServer((req, res) => {
      attempts.n += 1;
      if (attempts.n === 1) {
        req.socket.destroy();
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'unchanged', id: 'p:2030-03-11', rev: 9 }));
    });
    const retried = await tool(['publish', draftFile], flaky);
    expect(retried.exit).toBe(0);
    expect(attempts.n).toBe(2);
  });

  it.each<[string, number, string]>([
    ['the app shell from a static fallback', 200, '<!doctype html><title>fuel</title>'],
    ['JSON with no status', 200, '{"ok":true}'],
    ['a status it has never heard of', 200, '{"status":"landed-probably"}'],
    ['published with no rev or id', 200, '{"status":"published"}'],
    ['published under an error code', 500, '{"status":"published","id":"p:2030-03-11","rev":1}'],
    ['a refusal under a 200', 200, '{"status":"invalid","problems":[]}'],
    ['a server error', 500, '{"error":"internal error"}'],
    ['a route the server does not have', 404, '{"error":"not found"}'],
    ['JSON that is not an object', 200, '[]'],
    ['an empty answer', 200, ''],
  ])('never exits 0 on %s', async (_name, http, answer) => {
    const env = await fakeServer((_req, res) => {
      res.statusCode = http;
      res.end(answer);
    });
    const draftFile = join(scratch, 'draft.json');
    writeFileSync(draftFile, '{}');
    const { exit, line } = await tool(['publish', draftFile], env);
    expect(exit).toBe(1);
    expect(line).toEqual({ status: 'unexpected', http });
  });
});

describe('train.mjs read and status on odd answers', () => {
  it.each<[string, number, string]>([
    ['the app shell', 200, '<!doctype html>'],
    ['JSON missing the rev', 200, '{"draft":null}'],
    ['a server error', 500, '{"error":"internal error"}'],
  ])('read exits 1 on %s and writes nothing', async (_name, http, answer) => {
    const env = await fakeServer((_req, res) => {
      res.statusCode = http;
      res.end(answer);
    });
    const { exit, line } = await tool(['read'], env);
    expect(exit).toBe(1);
    expect(line).toEqual({ status: 'unexpected', http });
    expect(existsSync(env.FUEL_COACH_DIR)).toBe(false);
  });

  it('status exits 1 on anything but a health answer', async () => {
    const env = await fakeServer((_req, res) => {
      res.end('<!doctype html>');
    });
    expect((await tool(['status'], env)).exit).toBe(1);
  });
});

describe('train.mjs status', () => {
  it('exits 0 once a phone has reported, naming the build', async () => {
    const { env } = await realServer({ seeded: false });
    const { exit, line } = await tool(['status'], env);
    expect(exit).toBe(0);
    expect(line).toEqual({ status: 'ready', rev: 0, phoneBuild: { build: 'abc-1', at: 77 } });
  });

  it('exits 5 before one has', async () => {
    const { env } = await realServer({ phone: false, seeded: false });
    const { exit, line } = await tool(['status'], env);
    expect(exit).toBe(5);
    expect(line).toEqual({ status: 'phone_behind', rev: 0 });
  });
});

describe('every command with the server down', () => {
  it.each([[['read']], [['status']]])('%j exits 4', async (args) => {
    const closed = await fakeServer((_req, res) => {
      res.end();
    });
    for (const cleanup of cleanups.splice(0)) await cleanup();
    const { exit, line } = await tool(args, closed);
    expect(exit).toBe(4);
    expect(line).toEqual({ status: 'unreachable', url: closed.FUEL_URL });
  });
});

describe('scripts/coach-prompt.md', () => {
  const PROMPT = readFileSync(new URL('../scripts/coach-prompt.md', import.meta.url), 'utf8');
  const quoted = [...new Set([...PROMPT.matchAll(/`([^`\n]+)`/g)].flatMap((match) => match[1] ?? []))];

  const plan = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3, { cue: 'Slow down.', swaps: [{ liftId: lift('pec-deck'), label: 'Pec deck' }] }), slot('a2', 'cable-row', 3)], { onlyWeek: day('2030-03-18') })] }], {
    weeklyMinimum: 3,
    report: { text: 'Invented report.' },
    notes: [{ text: 'Invented note.', day: dayKey('push') }],
    changes: [{ target: 'slot:push/a2', why: 'Invented reason.' }],
    lifts: [
      { id: lift('bench-press'), name: 'Bench press', aliases: [], muscle: Muscle.parse('chest') },
      { id: lift('pec-deck'), name: 'Pec deck', aliases: [] },
      { id: lift('cable-row'), name: 'Cable row', aliases: [] },
    ],
  });

  /** Every key and string a JSON value holds. */
  function wordsIn(value: unknown): readonly string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(wordsIn);
    return isRecord(value) ? Object.entries(value).flatMap(([key, inner]) => [key, ...wordsIn(inner)]) : [];
  }

  /** The read as the route serves it, holding a session in each phase and a note from each source. */
  function fullSnapshot() {
    const now = ms(T0 + 100 * 3_600_000);
    const finished = session({ date: day('2030-03-05'), note: 'Invented.', finishedAt: minutes(60), skips: [{ slotId: slotId('a2'), note: 'Invented.' }] });
    const docs = {
      programRev: 1,
      programs: [{ doc: plan, rev: 1 }],
      sessions: [finished, session({ date: day('2030-03-06') }), session({ date: day('2030-03-07'), startedAt: ms(now - 60_000) }), session({ date: day('2030-03-08'), source: 'notion', startedAt: undefined })].map((doc) => ({ doc, rev: 2 })),
      performances: [{ doc: performance({ session: finished.id, date: finished.date, slot: 'a1', lift: 'bench-press', note: 'Invented.', sets: [{ ...lb(100, 8, 0), note: 'Invented.' }] }), rev: 2 }],
      trainingNotes: [{ id: TrainingNoteId.parse('1c2f7d8b-4a3e-4f6b-9cad-1e2f3a4b5c6d'), date: day('2030-03-09'), text: 'Invented.', at: now }],
      weighIns: [],
      entries: [],
      workouts: [],
    };
    return snapshotOf(docs, { today: day('2030-03-10'), now, phoneLastSyncAt: null });
  }

  it('names only fields and values the tool really has, running the commands it gives', async () => {
    const { env, file, store } = await realServer({ seeded: false });
    store.writeProgram(plan, { now: ms(1) });
    const read = await tool(['read'], env);
    const { draft: draftFile, snapshot: snapshotFile } = z.looseObject({ draft: z.string(), snapshot: z.string() }).parse(read.line);
    const { basedOnRev, ...draft } = z.looseObject({ basedOnRev: z.number() }).parse(JSON.parse(readFileSync(draftFile, 'utf8')));
    const dryRun = await tool(['publish', draftFile, '--dry-run'], env);
    const invalid = await tool(['publish', file('broken.json', { basedOnRev, ...draft, effectiveFrom: 'soon' }), '--dry-run'], env);
    const published = await tool(['publish', draftFile], env);
    const repeated = await tool(['publish', draftFile], env);
    expect([dryRun.exit, invalid.exit, published.exit, repeated.exit]).toEqual([0, 2, 0, 0]);
    expect(dryRun.line).toMatchObject({ phoneBehind: false });

    const known = new Set([
      ...wordsIn(JSON.parse(readFileSync(snapshotFile, 'utf8'))),
      ...wordsIn(JSON.parse(JSON.stringify(fullSnapshot()))),
      ...wordsIn(read.line),
      ...wordsIn(dryRun.line),
      ...wordsIn(invalid.line),
      ...wordsIn(published.line),
      ...wordsIn(repeated.line),
      ...PublishAnswer.options.map((answer) => answer.shape.status.value),
    ]);
    /** Run above or below, or the tool's line with the server down, which has its own test. */
    const LITERAL = ['node scripts/train.mjs', 'node scripts/train.mjs read', 'node scripts/train.mjs publish <draft.json>', 'node scripts/train.mjs publish <draft.json> --dry-run', 'snapshot.json', 'draft.json', 'phoneBehind: true', '{ "text": "..." }', 'slot:push/a2', 'cue:push/a1', 'prescription:push/a1', 'unreachable'];
    expect(quoted.filter((word) => !known.has(word) && !LITERAL.includes(word))).toEqual([]);
    expect(Report.parse(JSON.parse('{ "text": "..." }'))).toEqual({ text: '...' });
  });

  it('gives the targets a dry run really prints, with a reason where one is refused without it', async () => {
    const { env, file, store } = await realServer({ seeded: false });
    store.writeProgram(plan, { now: ms(1) });
    const read = await tool(['read'], env);
    const { draft: draftFile } = z.looseObject({ draft: z.string() }).parse(read.line);
    const { basedOnRev, ...saved } = z.looseObject({ basedOnRev: z.number() }).parse(JSON.parse(readFileSync(draftFile, 'utf8')));
    const edited = ProgramDraft.parse(saved);
    const a1 = slot('a1', 'bench-press', 4, { cue: 'Slower.', swaps: [{ liftId: lift('pec-deck'), label: 'Pec deck' }] });
    const days = edited.days.map((one) => ({ ...one, blocks: [liftsBlock('a', [a1], { onlyWeek: day('2030-03-18') })] }));
    const changes = [{ target: 'slot:push/a2', why: 'Invented.' }, { target: 'prescription:push/a1', why: 'Invented.' }];
    const { line } = await tool(['publish', file('edited.json', { basedOnRev, ...edited, days, changes }), '--dry-run'], env);
    const { diff } = z.looseObject({ diff: z.array(z.looseObject({ target: z.string(), why: z.string().nullable() })) }).parse(line);
    expect(diff.map((item) => [item.target, item.why])).toEqual([['prescription:push/a1', 'Invented.'], ['cue:push/a1', null], ['slot:push/a2', 'Invented.']]);
    for (const { target } of diff) expect(PROMPT).toContain(`\`${target}\``);
  });
});
