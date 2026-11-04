import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openReplica } from '../src/client/replica.js';
import { syncRounds, type Transport } from '../src/client/sync.js';
import { ProgramDraft, type Program } from '../src/domain/program.js';
import { PublishAnswer, Rev, SyncReply, SyncResponse } from '../src/protocol.js';
import { buildApp } from '../src/server/routes.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { entry, newClientId, newEntryId, putEntry, request } from './fixtures.js';
import { day, dayKey, liftsBlock, ms, noFoods, noonOf, program, session, slot } from './training.fixtures.js';

const SUNDAY = '2030-03-10';
const MONDAY = '2030-03-11';

const stores: DocStore[] = [];
let stdout: ReturnType<typeof spyOnStdout>;
const spyOnStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

beforeEach(() => {
  stdout = spyOnStdout();
});
afterEach(() => {
  stdout.mockRestore();
  for (const s of stores.splice(0)) s.close();
});

const Snapshot = z.looseObject({
  today: z.string(),
  targetMonday: z.string(),
  basedOnRev: Rev,
  phoneLastSyncAt: z.number().nullable(),
  program: z.looseObject({ id: z.string() }).nullable(),
  draft: ProgramDraft.nullable(),
  weeks: z.array(z.looseObject({ monday: z.string() })),
});

const version = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3, { cue: 'Elbows in' }), slot('a2', 'row', 3)])] }], { notes: [{ text: 'A callout' }] });

function draftOf({ id: _id, publishedAt: _publishedAt, ...rest }: Program, effectiveFrom: string): ProgramDraft {
  return { ...rest, effectiveFrom: day(effectiveFrom), changes: [] };
}

/** A real store and app on a clock the test moves. */
function setup(options: { readonly seeded?: boolean; readonly phone?: boolean } = {}) {
  const store = openStore(':memory:');
  stores.push(store);
  const clock = { date: SUNDAY };
  const app = buildApp({ store, foods: noFoods, ai: null, staticDir: '.', now: () => noonOf(clock.date) });
  const phoneReports = () => store.sync({ ...request(newClientId(), []), build: 'abc-1' }, { now: ms(77), userAgent: null });
  if (options.phone ?? true) phoneReports();
  if (options.seeded ?? true) store.writeProgram(version, { now: ms(1) });

  const send = async (body: BodyInit, query = '') => {
    const res = await app.request(`/api/train/publish${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { http: res.status, answer: PublishAnswer.parse(await res.json()) };
  };
  return {
    store,
    clock,
    app,
    phoneReports,
    send,
    publish: (draft: Readonly<Record<string, unknown>>, basedOnRev: unknown = store.highestRev('program'), query = '') => send(JSON.stringify({ basedOnRev, ...draft }), query),
    snapshot: async (query = '') => {
      const res = await app.request(`/api/train/snapshot${query}`);
      return { http: res.status, body: Snapshot.parse(await res.json()) };
    },
    versions: () => store.liveDocs('program'),
  };
}

const problemsOf = (answer: PublishAnswer) => {
  if (answer.status !== 'invalid' && answer.status !== 'frozen') throw new Error(`no problems: ${answer.status}`);
  return answer.problems;
};

const onlyThe = (draft: ProgramDraft, text: string): ProgramDraft => ({ ...draft, notes: [{ text }] });

describe('GET /api/train/snapshot', () => {
  it('reads an empty database', async () => {
    const { snapshot } = setup({ seeded: false, phone: false });
    const { http, body } = await snapshot();
    expect(http).toBe(200);
    expect(body).toMatchObject({ today: SUNDAY, targetMonday: MONDAY, basedOnRev: 0, phoneLastSyncAt: null, program: null, draft: null });
    expect(body.weeks).toHaveLength(6);
  });

  it('echoes the program rev, not the rev of everything, and when the phone last reported its build', async () => {
    const { store, snapshot } = setup();
    const programRev = store.highestRev('program');
    store.sync(request(newClientId(), [putEntry(1, entry(newEntryId(), 400))]), { now: ms(99), userAgent: null });
    expect(store.stats().rev).toBeGreaterThan(programRev);
    const { body } = await snapshot('?weeks=6');
    expect(body.basedOnRev).toBe(programRev);
    expect(body.phoneLastSyncAt).toBe(77);
  });

  it('reads the weeks asked for', async () => {
    const { snapshot } = setup();
    expect((await snapshot('?weeks=2')).body.weeks.map((week) => week.monday)).toEqual(['2030-02-25', '2030-03-04']);
  });

  it.each(['?weeks=0', '?weeks=53', '?weeks=x', '?weeks=1.5', '?weeks='])('answers 400 to %s', async (query) => {
    const { app } = setup();
    expect((await app.request(`/api/train/snapshot${query}`)).status).toBe(400);
  });

  it('hands out a draft that publishes for the target Monday with nothing to explain', async () => {
    const { snapshot, publish } = setup();
    const { body } = await snapshot();
    if (body.draft === null) throw new Error('expected a draft');
    expect(body.draft.effectiveFrom).toBe(MONDAY);
    expect(await publish(body.draft, body.basedOnRev)).toMatchObject({ http: 200, answer: { status: 'published', id: `p:${MONDAY}` } });
  });
});

describe('POST /api/train/publish', () => {
  it('writes the version under a stamp of its own, and answers what it stored', async () => {
    const { publish, versions, store } = setup();
    const before = store.stats().rev;
    const { http, answer } = await publish(draftOf(version, MONDAY));
    expect(http).toBe(200);
    expect(answer).toEqual({ status: 'published', id: `p:${MONDAY}`, rev: before + 1 });
    const stored = versions().find((row) => row.doc.id === `p:${MONDAY}`);
    expect(stored?.rev).toBe(before + 1);
    expect(stored?.doc.publishedAt).toBe(noonOf(SUNDAY));
    expect(stored?.doc.notes).toEqual([{ text: 'A callout' }]);
  });

  describe('invalid', () => {
    it('reports every shape problem at once, each naming its path, with a bad basedOnRev among them', async () => {
      const { publish, store } = setup();
      const rev = store.stats().rev;
      const { http, answer } = await publish({ effectiveFrom: 'soon', days: [], lifts: 'none', notes: [], standing: [], changes: [{ target: ' ', why: 'x' }], sessions: [{}], publishedAt: 5 }, 'not a rev');
      expect(http).toBe(422);
      expect(answer.status).toBe('invalid');
      expect(problemsOf(answer).map((p) => p.path).toSorted()).toEqual(['basedOnRev', 'changes[0].target', 'days', 'effectiveFrom', 'lifts', 'publishedAt', 'sessions'].toSorted());
      expect(store.stats().rev).toBe(rev);
    });

    it('reports every rule a well-formed draft breaks at once', async () => {
      const { publish, store } = setup();
      const rev = store.stats().rev;
      const draft = draftOf(version, '2030-03-09');
      const { http, answer } = await publish({
        ...draft,
        days: [{ key: dayKey('push'), label: 'Push', blocks: [liftsBlock('a', [slot('a1', 'no-such-lift', 3), slot('a2', 'row', 3)], { onlyWeek: day('2030-03-12') })] }],
      });
      expect(http).toBe(422);
      expect(problemsOf(answer).map((p) => [p.code, p.path])).toEqual([
        ['back-dated', 'effectiveFrom'],
        ['unknown-lift', 'days[0].blocks[0].slots[0].liftId'],
        ['bad-only-week', 'days[0].blocks[0].onlyWeek'],
        ['unexplained', 'changes'],
        ['unexplained', 'changes'],
        ['unexplained', 'changes'],
      ]);
      expect(store.stats().rev).toBe(rev);
    });

    it.each([
      ['not JSON', '{"basedOnRev": 1,'],
      ['JSON that is not an object', '[1, 2]'],
      ['an empty body', ''],
    ])('answers %s with a problem at (body)', async (_name, body) => {
      const { send } = setup();
      const { http, answer } = await send(body);
      expect(http).toBe(422);
      expect(problemsOf(answer)[0]?.path).toBe('(body)');
    });

    it('answers a body over the limit the same way, as a named status', async () => {
      const { send } = setup();
      const { http, answer } = await send(JSON.stringify({ basedOnRev: 1, padding: 'x'.repeat(1024 * 1024 + 1) }));
      expect(http).toBe(422);
      expect(problemsOf(answer)[0]?.path).toBe('(body)');
    });
  });

  describe('publishing twice', () => {
    it('answers unchanged, moves no rev and keeps the first stamp', async () => {
      const { publish, store, versions } = setup();
      const draft = draftOf(version, MONDAY);
      const first = await publish(draft);
      const rev = store.stats().rev;
      const stamped = versions().find((row) => row.doc.id === `p:${MONDAY}`)?.doc.publishedAt;
      const second = await publish(draft);
      expect(second).toEqual({ http: 200, answer: { status: 'unchanged', id: `p:${MONDAY}`, rev } });
      expect(first.answer.status).toBe('published');
      expect(store.stats().rev).toBe(rev);
      expect(versions().find((row) => row.doc.id === `p:${MONDAY}`)?.doc.publishedAt).toBe(stamped);
    });
  });

  describe('frozen', () => {
    const changed = onlyThe(draftOf(version, '2030-03-04'), 'Rewriting history');

    it('refuses to replace a version in effect, names today as the earliest date, and writes nothing', async () => {
      const { publish, versions } = setup();
      const before = versions();
      const { http, answer } = await publish(changed);
      expect(http).toBe(409);
      expect(answer).toMatchObject({ status: 'frozen', id: version.id, earliestEffectiveFrom: SUNDAY });
      expect(versions()).toEqual(before);
    });

    it('names tomorrow once today already has a version', async () => {
      const { publish } = setup();
      await publish(draftOf(version, SUNDAY));
      const { http, answer } = await publish(onlyThe(draftOf(version, SUNDAY), 'A second thought'));
      expect(http).toBe(409);
      expect(answer).toMatchObject({ status: 'frozen', id: `p:${SUNDAY}`, earliestEffectiveFrom: MONDAY });
    });

    it('freezes an upcoming version when its date arrives, which until then can be replaced', async () => {
      const { publish, clock } = setup();
      await publish(draftOf(version, MONDAY));
      expect((await publish(onlyThe(draftOf(version, MONDAY), 'Sunday evening'))).answer.status).toBe('published');
      clock.date = MONDAY;
      expect((await publish(onlyThe(draftOf(version, MONDAY), 'Monday morning'))).answer.status).toBe('frozen');
    });
  });

  describe('stale', () => {
    it('refuses a draft read before the plan moved, and writes nothing', async () => {
      const { publish, store, versions } = setup();
      const read = store.highestRev('program');
      const moved = await publish(draftOf(version, MONDAY), read);
      if (moved.answer.status !== 'published') throw new Error(moved.answer.status);
      const before = versions();
      const { http, answer } = await publish(onlyThe(draftOf(version, MONDAY), 'From the old read'), read);
      expect(http).toBe(409);
      expect(answer).toEqual({ status: 'stale', basedOnRev: read, currentRev: moved.answer.rev });
      expect(versions()).toEqual(before);
    });

    it('is not moved by a phone logging in the meantime', async () => {
      const { publish, store } = setup();
      const read = store.highestRev('program');
      store.sync(request(newClientId(), [putEntry(1, entry(newEntryId(), 400))]), { now: ms(2), userAgent: null });
      expect((await publish(draftOf(version, MONDAY), read)).answer.status).toBe('published');
    });

    it('lets the next publish base itself on the rev the last one answered', async () => {
      const { publish, store } = setup();
      const first = await publish(draftOf(version, MONDAY), store.highestRev('program'));
      if (first.answer.status !== 'published') throw new Error(first.answer.status);
      expect((await publish(draftOf(version, '2030-03-18'), first.answer.rev)).answer.status).toBe('published');
    });
  });

  describe('silent drops', () => {
    const dropped = (changes: ProgramDraft['changes']): ProgramDraft => ({
      ...draftOf(version, MONDAY),
      days: [{ key: dayKey('push'), label: 'Day push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }],
      changes,
    });

    it('refuses an unexplained dropped slot and cue, naming what to explain, and writes nothing', async () => {
      const { publish, versions } = setup();
      const before = versions();
      const { http, answer } = await publish(dropped([]));
      expect(http).toBe(422);
      expect(answer.status).toBe('invalid');
      const messages = problemsOf(answer).map((p) => p.message);
      expect(problemsOf(answer).every((p) => p.code === 'unexplained')).toBe(true);
      expect(messages).toHaveLength(2);
      expect(messages.find((m) => m.startsWith('cue-removed'))).toContain('cue:push/a1');
      expect(messages.find((m) => m.startsWith('slot-removed'))).toContain('slot:push/a2');
      expect(versions()).toEqual(before);
    });

    it('still refuses with one of the two explained, and publishes with both', async () => {
      const { publish } = setup();
      const cue = { target: 'cue:push/a1', why: 'He has it now' };
      const row = { target: 'slot:push/a2', why: 'The machine is gone' };
      expect((await publish(dropped([cue]))).http).toBe(422);
      expect(await publish(dropped([cue, row]))).toMatchObject({ http: 200, answer: { status: 'published' } });
    });
  });

  describe('a lost response', () => {
    it('answers the retry unchanged, though the rev it read has since moved', async () => {
      const { publish, store } = setup();
      const read = store.highestRev('program');
      const draft = draftOf(version, MONDAY);
      await publish(draft, read);
      const landed = store.stats().rev;
      expect(await publish(draft, read)).toEqual({ http: 200, answer: { status: 'unchanged', id: `p:${MONDAY}`, rev: landed } });
      expect(store.stats().rev).toBe(landed);
    });

    it('answers unchanged rather than frozen when the retry comes after the date has arrived', async () => {
      const { publish, store, clock } = setup();
      const read = store.highestRev('program');
      const draft = draftOf(version, MONDAY);
      await publish(draft, read);
      clock.date = '2030-03-12';
      expect((await publish(draft, read)).answer.status).toBe('unchanged');
    });
  });

  describe('a phone that has not reported a build', () => {
    it('refuses the write, and writes nothing, until one does', async () => {
      const { publish, phoneReports, store, versions } = setup({ phone: false });
      const before = versions();
      const { http, answer } = await publish(draftOf(version, MONDAY));
      expect(http).toBe(409);
      expect(answer).toEqual({ status: 'phone_behind' });
      expect(versions()).toEqual(before);
      phoneReports();
      expect((await publish(draftOf(version, MONDAY), store.highestRev('program'))).answer.status).toBe('published');
    });

    it('still names an invalid, frozen or stale draft first, because those need fixing whatever the phone does', async () => {
      const { publish } = setup({ phone: false });
      expect((await publish(draftOf(version, '2030-03-09'))).answer.status).toBe('invalid');
      expect((await publish(onlyThe(draftOf(version, '2030-03-04'), 'x'))).answer.status).toBe('frozen');
      expect((await publish(draftOf(version, MONDAY), 0)).answer.status).toBe('stale');
    });
  });

  describe('a dry run', () => {
    it('answers the diff and writes nothing', async () => {
      const { publish, store, versions } = setup();
      const before = versions();
      const rev = store.stats().rev;
      const draft: ProgramDraft = { ...draftOf(version, MONDAY), days: [{ key: dayKey('push'), label: 'Day push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3), slot('a2', 'row', 3)])] }], changes: [{ target: 'cue:push/a1', why: 'He has it now' }] };
      const { http, answer } = await publish(draft, undefined, '?dryRun=1');
      expect(http).toBe(200);
      expect(answer).toMatchObject({ status: 'dry-run', id: `p:${MONDAY}`, phoneBehind: false, diff: [{ kind: 'cue-removed', target: 'cue:push/a1', before: 'Elbows in', after: null, needsReason: true, why: 'He has it now' }] });
      expect(store.stats().rev).toBe(rev);
      expect(versions()).toEqual(before);
    });

    it('is not blocked by the phone gate, and says the real publish would be', async () => {
      const { publish, store } = setup({ phone: false });
      const rev = store.stats().rev;
      const { http, answer } = await publish(draftOf(version, MONDAY), undefined, '?dryRun=1');
      expect(http).toBe(200);
      expect(answer).toMatchObject({ status: 'dry-run', phoneBehind: true });
      expect(store.stats().rev).toBe(rev);
    });

    it('answers invalid, frozen, stale and unchanged as the real publish would', async () => {
      const { publish, store } = setup();
      const read = store.highestRev('program');
      expect((await publish(draftOf(version, '2030-03-09'), read, '?dryRun=1')).answer.status).toBe('invalid');
      expect((await publish(onlyThe(draftOf(version, '2030-03-04'), 'x'), read, '?dryRun=1')).answer.status).toBe('frozen');
      await publish(draftOf(version, MONDAY), read);
      expect((await publish(draftOf(version, MONDAY), read, '?dryRun=1')).answer.status).toBe('unchanged');
      expect((await publish(onlyThe(draftOf(version, MONDAY), 'x'), read, '?dryRun=1')).answer.status).toBe('stale');
    });

    it('refuses any other dryRun value rather than publishing for real', async () => {
      const { publish, store } = setup();
      const rev = store.stats().rev;
      const { http, answer } = await publish(draftOf(version, MONDAY), undefined, '?dryRun=true');
      expect(http).toBe(422);
      expect(problemsOf(answer)[0]?.path).toBe('dryRun');
      expect(store.stats().rev).toBe(rev);
    });
  });
});

describe('what the routes log', () => {
  it('names the route and status and nothing from a body, whatever the answer', async () => {
    const { publish, send, snapshot } = setup();
    const secret = onlyThe(draftOf(version, MONDAY), 'SECRET left knee');
    await snapshot();
    await publish(secret, undefined, '?dryRun=1');
    await publish(secret);
    await publish(secret, 0);
    await publish({ ...secret, cue: 'SECRET field' });
    await send('{"SECRET": ');

    const lines = stdout.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('SECRET'))).toEqual([]);
    const LogLine = z.strictObject({ at: z.string(), event: z.literal('train'), route: z.enum(['snapshot', 'publish']), status: z.string() });
    expect(lines.map((line) => LogLine.parse(JSON.parse(line))).map((line) => [line.route, line.status])).toEqual([
      ['snapshot', 'ok'],
      ['publish', 'dry-run'],
      ['publish', 'published'],
      ['publish', 'unchanged'],
      ['publish', 'invalid'],
      ['publish', 'invalid'],
    ]);
  });
});

describe('a phone after a publish', () => {
  it('holds the new version on its next sync, and reads it as the program in effect from its date', async () => {
    const { app, publish, store, versions } = setup({ phone: false });
    const { replica, port } = await openReplica({ name: 'train-routes', indexedDB: new IDBFactory(), IDBKeyRange, build: 'abc-1' });
    const transport: Transport = async (req) => {
      const res = await app.request('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      return SyncReply.parse(await res.json());
    };

    await syncRounds(port, transport);
    expect(await replica.read.programOn(day(MONDAY))).toEqual(version);

    const { answer } = await publish(draftOf(version, MONDAY), store.highestRev('program'));
    expect(answer.status).toBe('published');
    expect(await replica.read.programOn(day(MONDAY)), 'nothing reaches it before it syncs').toEqual(version);

    await syncRounds(port, transport);
    const published = versions().find((row) => row.doc.id === `p:${MONDAY}`)?.doc;
    expect(published).toBeDefined();
    expect(await replica.read.programOn(day(MONDAY))).toEqual(published);
    expect(await replica.read.programOn(day('2030-03-17'))).toEqual(published);
    expect(await replica.read.programOn(day(SUNDAY)), 'the day before its date reads the version before it').toEqual(version);
    replica.close();
  });

  it('moves a session pinned on a copy the mini has replaced, the one case the calendar rule does not cover', async () => {
    const { app, publish, store, clock } = setup({ phone: false });
    const { replica, port } = await openReplica({ name: 'train-pin-gap', indexedDB: new IDBFactory(), IDBKeyRange, build: 'abc-1' });
    const transport: Transport = async (req) => SyncReply.parse(await (await app.request('/api/sync', { method: 'POST', body: JSON.stringify(req) })).json());
    await syncRounds(port, transport);
    await publish(onlyThe(draftOf(version, MONDAY), 'Sunday morning'));
    await syncRounds(port, transport);
    await publish(onlyThe(draftOf(version, MONDAY), 'Sunday evening'));

    clock.date = MONDAY;
    const held = await replica.read.programOn(day(MONDAY));
    expect(held?.notes, 'offline on Monday, it holds the first copy').toEqual([{ text: 'Sunday morning' }]);
    const open = session({ date: day(MONDAY), ...(held === undefined ? {} : { programId: held.id }) });
    await replica.commit([{ op: 'put', kind: 'session', doc: open }]);

    await syncRounds(port, transport);
    expect((await replica.read.get('session', open.id))?.programId, 'the pin itself stays').toBe(`p:${MONDAY}`);
    expect((await replica.read.programOn(day(MONDAY)))?.notes, 'but its next sync brings the replacement').toEqual([{ text: 'Sunday evening' }]);
    expect((await publish(onlyThe(draftOf(version, MONDAY), 'Monday'), store.highestRev('program'))).answer.status, 'and from here the version is frozen').toBe('frozen');
    replica.close();
  });

  it('pulls it like any change, above a cursor that had seen everything', async () => {
    const { app, publish, store, phoneReports } = setup({ phone: false });
    const seen = SyncResponse.parse(phoneReports());
    await publish(draftOf(version, MONDAY));
    const res = await app.request('/api/sync', { method: 'POST', body: JSON.stringify(request(newClientId(), [], seen.cursor, seen.epoch)) });
    const { changes } = SyncResponse.parse(await res.json());
    expect(changes.map((c) => [c.kind, c.id, c.rev])).toEqual([['program', `p:${MONDAY}`, store.highestRev('program')]]);
  });
});
