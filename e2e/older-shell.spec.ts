/**
 * A shell older than its server, on a production build: a pull holding a kind it has never
 * heard of leaves sync green, and a new build reads that record after all. The server only
 * stores kinds it knows, so a route relabels one real entry on its way to the old shell.
 * Dropping the relabel at the new build is the same as that build learning the kind.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import type { Entry } from '../src/domain/diary.js';
import { EntryId, Millis, TrainingNoteId } from '../src/domain/ids.js';
import type { Kind, Mutation } from '../src/domain/kinds.js';
import { Healthz, SyncRequest, SyncResponse } from '../src/protocol.js';
import { lb, liftsBlock, newSessionId, performance, program, session, slot } from '../test/training.fixtures.js';
import { seed, stored, tab } from './app.js';

// page.route cannot see what a service worker answers, and a new build here is the page's own script rewritten on its way in.
test.use({ serviceWorkers: 'block' });

function snack(name: string): Entry {
  return {
    id: EntryId.parse(randomUUID()),
    date: localDate(),
    meal: 'snacks',
    loggedAt: Millis.parse(Date.now()),
    food: { name, unit: 'portion', nutrients: { kcal: 123 }, servings: [], origin: { kind: 'adhoc' } },
    quantity: { kind: 'amount', amount: 1 },
  };
}

async function quickAdd(page: Page, what: string) {
  await page.getByRole('button', { name: 'Add to Snacks' }).click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  const sheet = page.getByRole('dialog', { name: 'Quick add' });
  await sheet.getByLabel('What').fill(what);
  await sheet.getByLabel('Calories').fill('250');
  await sheet.getByRole('button', { name: 'Log to Snacks' }).click();
}

async function reportedBuild(request: APIRequestContext) {
  return Healthz.parse(await (await request.get('/healthz')).json()).phoneBuild?.build;
}

/** The first request after `open` runs, once the shell it loads has synced. */
async function firstSyncAfter(sent: readonly SyncRequest[], open: () => Promise<unknown>) {
  const mark = sent.length;
  await open();
  await expect.poll(() => sent.length).toBeGreaterThan(mark);
  const first = sent[mark];
  if (first === undefined) throw new Error('no sync request');
  return first;
}

test('a pull holding an unknown kind leaves sync green, and a new build re-pulls the record', async ({ page, request }) => {
  const before = snack('Before the unknown kind');
  const unknown = snack('Once an unknown kind');
  const after = snack('After the unknown kind');
  const logged = 'Logged by the old shell';
  const loggedLater = 'Logged after the skip';

  let connected = true;
  let relabel: string | null = unknown.id;
  const sent: SyncRequest[] = [];
  const answered: SyncResponse[] = [];
  await page.route('**/api/sync', async (route) => {
    if (!connected) return route.abort('internetdisconnected');
    sent.push(SyncRequest.parse(route.request().postDataJSON()));
    const body = SyncResponse.parse(await (await route.fetch()).json());
    answered.push(body);
    const changes = body.changes.map((c) => (c.id === relabel ? { ...c, kind: 'futureKind' } : c));
    return route.fulfill({ json: { ...body, changes } });
  });

  await firstSyncAfter(sent, () => page.goto('/'));
  connected = false;

  await quickAdd(page, logged);
  await expect(page.getByText('1 waiting')).toBeVisible();
  await seed(request, [before, unknown, after].map((doc) => ({ op: 'put', kind: 'entry', doc })));
  connected = true;

  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  const batch = answered.find((a) => a.changes.some((c) => c.id === unknown.id));
  expect(batch?.lastMutationId, 'the record arrives with the ack that clears the outbox').toBeGreaterThan(0);
  expect(batch?.changes.map((c) => c.id)).toEqual(expect.arrayContaining([before.id, after.id]));
  const unknownRev = batch?.changes.find((c) => c.id === unknown.id)?.rev ?? 0;

  const snacks = page.getByRole('region', { name: 'Snacks' });
  await expect(snacks.getByText(before.food.name)).toBeVisible();
  await expect(snacks.getByText(after.food.name)).toBeVisible();
  await expect(snacks.getByText(unknown.food.name)).toBeHidden();
  expect(stored('entry').map((e) => e.food.name)).toContain(logged);

  await quickAdd(page, loggedLater);
  await expect(snacks.getByText(loggedLater)).toBeVisible();
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  expect(stored('entry').map((e) => e.food.name)).toContain(loggedLater);

  const sameBuild = await firstSyncAfter(sent, () => page.reload());
  expect(sameBuild.cursor, 'the same build does not re-pull').toBeGreaterThanOrEqual(unknownRev);
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(before.food.name)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(unknown.food.name)).toBeHidden();

  await tab(page, 'Goal').click();
  const build = (await page.getByTestId('build').textContent())?.replace('Build ', '') ?? '';
  expect(build).toMatch(/^[0-9a-f]{7,}$/);
  await expect.poll(() => reportedBuild(request)).toBe(build);

  const nextBuild = `${build}-next`;
  await page.route('**/assets/*.js', async (route) => {
    const script = await (await route.fetch()).text();
    return route.fulfill({ contentType: 'text/javascript', body: script.replaceAll(build, nextBuild) });
  });
  relabel = null;

  const repull = await firstSyncAfter(sent, () => page.reload());
  expect(repull, 'the new build pulls from just before what the old one skipped').toMatchObject({ build: nextBuild, cursor: unknownRev - 1 });
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(unknown.food.name)).toBeVisible();
  await expect.poll(() => reportedBuild(request)).toBe(nextBuild);

  await tab(page, 'Goal').click();
  await expect(page.getByTestId('build')).toHaveText(`Build ${nextBuild}`);

  const afterRepull = await firstSyncAfter(sent, () => page.reload());
  expect(afterRepull.cursor, 'the note is gone once the re-pull applied').toBeGreaterThanOrEqual(unknownRev);
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(unknown.food.name)).toBeVisible();

  // shots.spec photographs today's diary.
  const names = new Set([before.food.name, unknown.food.name, after.food.name, logged, loggedLater]);
  await seed(request, stored('entry').filter((e) => names.has(e.food.name)).map((e): Mutation => ({ op: 'delete', kind: 'entry', id: e.id })));
});

/** The kinds this build added, as a shell one build older would meet them. */
const ADDED_KINDS: ReadonlySet<Kind> = new Set<Kind>(['program', 'session', 'performance', 'trainingNote']);

function oneOfEachAddedKind() {
  const plan = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('a', [slot('a1', 'bench-press', 3)])] }]);
  const done = session({ id: newSessionId(), programId: plan.id });
  const set = performance({ session: done.id, date: done.date, slot: 'a1', lift: 'bench-press', sets: [lb(100, 8, 1)] });
  const note = { id: TrainingNoteId.parse(randomUUID()), date: done.date, text: 'Invented line to the coach.', at: Millis.parse(Date.now()) };
  const ids: string[] = [plan.id, done.id, set.id, note.id];
  const puts: Mutation[] = [
    { op: 'put', kind: 'program', doc: plan },
    { op: 'put', kind: 'session', doc: done },
    { op: 'put', kind: 'performance', doc: set },
    { op: 'put', kind: 'trainingNote', doc: note },
  ];
  const deletes: Mutation[] = [
    { op: 'delete', kind: 'program', id: plan.id },
    { op: 'delete', kind: 'session', id: done.id },
    { op: 'delete', kind: 'performance', id: set.id },
    { op: 'delete', kind: 'trainingNote', id: note.id },
  ];
  return { ids: ids.toSorted(), puts, deletes };
}

/** The ids the phone's own IndexedDB holds for each added kind, read past the app, which has no screen for them yet. */
function heldOnPhone(page: Page) {
  return page.evaluate(
    (kinds) =>
      new Promise<string[]>((resolve, reject) => {
        const opening = indexedDB.open('fuel');
        opening.onerror = () => reject(new Error('could not open fuel'));
        opening.onsuccess = () => {
          const db = opening.result;
          const transaction = db.transaction(kinds);
          const keys = kinds.map((kind) => transaction.objectStore(kind).getAllKeys());
          transaction.oncomplete = () => {
            db.close();
            resolve(keys.flatMap((request) => request.result.map(String)));
          };
        };
      }),
    [...ADDED_KINDS],
  );
}

test('a pull carrying a document of each new kind leaves a shell one build older green, and its update reads them', async ({ page, request }) => {
  const trouble: string[] = [];
  page.on('pageerror', (err) => trouble.push(err.message));
  page.on('console', (message) => {
    if (message.type() === 'error') trouble.push(message.text());
  });

  const before = snack('Before the new kinds');
  const after = snack('After the new kinds');
  const logged = 'Logged beside the new kinds';
  const loggedLater = 'Logged after skipping the new kinds';
  const added = oneOfEachAddedKind();

  let connected = true;
  let olderShell = true;
  const sent: SyncRequest[] = [];
  const answered: SyncResponse[] = [];
  await page.route('**/api/sync', async (route) => {
    if (!connected) return route.abort('internetdisconnected');
    sent.push(SyncRequest.parse(route.request().postDataJSON()));
    const body = SyncResponse.parse(await (await route.fetch()).json());
    answered.push(body);
    const changes = body.changes.map((c) => (olderShell && ADDED_KINDS.has(c.kind) ? { ...c, kind: `unheardOf-${c.kind}` } : c));
    return route.fulfill({ json: { ...body, changes } });
  });

  await firstSyncAfter(sent, () => page.goto('/'));
  connected = false;
  await quickAdd(page, logged);
  await expect(page.getByText('1 waiting')).toBeVisible();

  await seed(request, [{ op: 'put', kind: 'entry', doc: before }, ...added.puts, { op: 'put', kind: 'entry', doc: after }]);
  connected = true;

  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  const carried = answered.flatMap((a) => a.changes).filter((c) => added.ids.includes(c.id));
  expect(carried.map((c) => c.kind).toSorted(), 'a pull really carried one of each').toEqual([...ADDED_KINDS].toSorted());
  expect(answered.some((a) => a.lastMutationId > 0 && a.changes.some((c) => added.ids.includes(c.id))), 'the ack that clears the outbox came with them').toBe(true);

  const snacks = page.getByRole('region', { name: 'Snacks' });
  await expect(snacks.getByText(before.food.name)).toBeVisible();
  await expect(snacks.getByText(after.food.name)).toBeVisible();
  expect(stored('entry').map((e) => e.food.name)).toContain(logged);
  expect(await heldOnPhone(page), 'the shell kept none of what it could not read').toEqual([]);

  await quickAdd(page, loggedLater);
  await expect(snacks.getByText(loggedLater)).toBeVisible();
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  expect(stored('entry').map((e) => e.food.name)).toContain(loggedLater);
  expect(trouble, 'nothing threw and nothing logged an error').toEqual([]);

  await tab(page, 'Goal').click();
  const build = (await page.getByTestId('build').textContent())?.replace('Build ', '') ?? '';
  expect(build).toMatch(/^[0-9a-f]{7,}$/);
  await expect.poll(() => reportedBuild(request), 'the phone still reports its build').toBe(build);

  const nextBuild = `${build}-next`;
  await page.route('**/assets/*.js', async (route) => {
    const script = await (await route.fetch()).text();
    return route.fulfill({ contentType: 'text/javascript', body: script.replaceAll(build, nextBuild) });
  });
  olderShell = false;

  const lowest = Math.min(...carried.map((c) => c.rev));
  const repull = await firstSyncAfter(sent, () => page.reload());
  expect(repull, 'the update pulls from just before what the older shell skipped').toMatchObject({ build: nextBuild, cursor: lowest - 1 });
  await expect.poll(async () => (await heldOnPhone(page)).toSorted(), 'the update reads each new kind').toEqual(added.ids);
  await expect(page.getByText(/\d+ waiting/)).toBeHidden();
  expect(trouble).toEqual([]);

  const names = new Set([before.food.name, after.food.name, logged, loggedLater]);
  await seed(request, [...stored('entry').filter((e) => names.has(e.food.name)).map((e): Mutation => ({ op: 'delete', kind: 'entry', id: e.id })), ...added.deletes]);
});
