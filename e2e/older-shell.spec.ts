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
import { EntryId, Millis } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import { Healthz, SyncRequest, SyncResponse } from '../src/protocol.js';
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
  /** The first request after `open` runs, once the shell it loads has synced. */
  const firstSyncAfter = async (open: () => Promise<unknown>) => {
    const mark = sent.length;
    await open();
    await expect.poll(() => sent.length).toBeGreaterThan(mark);
    const first = sent[mark];
    if (first === undefined) throw new Error('no sync request');
    return first;
  };

  await firstSyncAfter(() => page.goto('/'));
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

  const sameBuild = await firstSyncAfter(() => page.reload());
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

  const repull = await firstSyncAfter(() => page.reload());
  expect(repull, 'the new build pulls from just before what the old one skipped').toMatchObject({ build: nextBuild, cursor: unknownRev - 1 });
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(unknown.food.name)).toBeVisible();
  await expect.poll(() => reportedBuild(request)).toBe(nextBuild);

  await tab(page, 'Goal').click();
  await expect(page.getByTestId('build')).toHaveText(`Build ${nextBuild}`);

  const afterRepull = await firstSyncAfter(() => page.reload());
  expect(afterRepull.cursor, 'the note is gone once the re-pull applied').toBeGreaterThanOrEqual(unknownRev);
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText(unknown.food.name)).toBeVisible();

  // shots.spec photographs today's diary.
  const names = new Set([before.food.name, unknown.food.name, after.food.name, logged, loggedLater]);
  await seed(request, stored('entry').filter((e) => names.has(e.food.name)).map((e): Mutation => ({ op: 'delete', kind: 'entry', id: e.id })));
});
