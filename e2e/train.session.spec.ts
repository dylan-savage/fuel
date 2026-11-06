/**
 * Logging at the gym, on a production build. Each test keeps to its own invented week, later than
 * any other spec's clock and earlier than the test before it, so a session one leaves open is still
 * in the future for the next and nothing settles it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PROFILE_ID, goalId } from '../src/domain/goals.js';
import { addDays } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import { sessionWorkoutId } from '../src/domain/session.js';
import { cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, ms, performance, program, session, slot, target } from '../test/training.fixtures.js';
import { countOnPhone, openControlled, seed, stored, tab } from './app.js';

const at = (date: string, time = '18:00:00') => new Date(`${date}T${time}`);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const card = (page: Page) => page.getByRole('region', { name: 'Set', exact: true });
const title = (page: Page, name: string) => page.getByRole('heading', { name, exact: true, level: 1 });
const dayRow = (page: Page, name: RegExp) => page.getByRole('list', { name: 'Days' }).getByRole('button', { name });
const row = (page: Page, name: RegExp) => page.locator('.train').getByRole('button', { name });
const back = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();
const weekCount = (page: Page) => page.getByTestId('week-count');
const load = (page: Page) => page.getByLabel('Load', { exact: true });
const reps = (page: Page) => page.getByLabel('Reps', { exact: true });
const unit = (page: Page) => page.getByRole('button', { name: /^Unit / });
const logButton = (page: Page) => page.getByRole('button', { name: 'Log set' });
const logSet = (page: Page) => logButton(page).click();
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
const waiting = (page: Page) => page.getByText(/\d+ waiting/).filter({ visible: true });
const named = (name: string) => new RegExp(`^${name.replace(/[()]/g, '\\$&')}`);

async function openWeek(page: Page) {
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(weekCount(page)).toBeVisible({ timeout: 15_000 });
}

async function expectCard(page: Page, name: string, round: string) {
  await expect(card(page).getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByTestId('round')).toHaveText(round);
}

async function openDay(page: Page, name: string) {
  await dayRow(page, named(name)).click();
  await expect(title(page, name)).toBeVisible();
}

async function openExercise(page: Page, name: string, round: string) {
  await row(page, named(name)).click();
  await expectCard(page, name, round);
}

/** Notes on the root element if the Diary was ever on screen, which a reload mid-workout must not do. */
function watchForDiary(context: BrowserContext) {
  return context.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Breakfast"]') !== null) document.documentElement.dataset.sawDiary = 'yes';
    }).observe(document, { subtree: true, childList: true });
  });
}

const sawDiary = (page: Page) => page.evaluate(() => document.documentElement.dataset.sawDiary === 'yes');

/** What a return to the app does, which runs a sync and a settle with no write and no reload. */
const comeBackToApp = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const docs = (...lists: readonly (readonly Mutation[])[]) => lists.flat();
const putPrograms = (...doc: readonly ReturnType<typeof program>[]) => doc.map((d): Mutation => ({ op: 'put', kind: 'program', doc: d }));
const putPerformances = (...doc: readonly ReturnType<typeof performance>[]) => doc.map((d): Mutation => ({ op: 'put', kind: 'performance', doc: d }));
const weighInOn = (date: string): Mutation => ({ op: 'put', kind: 'weighIn', doc: { id: `w:${date}`, date: day(date), kg: 80, loggedAt: ms(at(date, '07:00:00').getTime()) } });

function reachesServer(date: string) {
  return stored('performance')
    .filter((p) => p.date === date)
    .map((p) => ({ lift: p.liftId, slot: p.slotId, planned: p.plannedLiftId, sets: p.sets.map((set) => ({ load: set.load, reps: set.reps, warmup: set.warmup === true })) }))
    .toSorted((a, b) => a.lift.localeCompare(b.lift));
}

const sessionsOn = (date: string) => stored('session').filter((s) => s.date === date);
const minutesOn = (date: string) => stored('workout').filter((w) => w.date === date).map((w) => w.minutes);

test('logs in any order and back again, offline through a tab switch, a reload and a page kill mid-set, then reaches the server', async ({ page, context, request }) => {
  const MONDAY = '2031-12-15';
  const DAY = '2031-12-17';
  const version = program(MONDAY, [
    {
      key: 'push',
      label: 'Push day',
      weekday: 3,
      blocks: [
        liftsBlock('pair', [slot('a1', 'cable-fly', 3, { label: 'Cable fly', target: target(3, 8, 12) }), slot('a2', 'meadows-row', 3, { label: 'Meadows row', target: target(3, 8, 12) })], { restSeconds: 75 }),
        liftsBlock('main', [slot('b1', 'pin-press', 3, { label: 'Pin press', target: target(3, 5, 8) })], { restSeconds: 120 }),
      ],
    },
  ]);
  const lastTime = [
    performance({ date: '2031-12-10', lift: 'cable-fly', label: 'Cable fly', sets: [lb(40, 12), lb(40, 11), lb(40, 10)], target: target(3, 8, 12) }),
    performance({ date: '2031-12-10', lift: 'meadows-row', label: 'Meadows row', sets: [lb(60, 10), lb(60, 9), lb(60, 9)], target: target(3, 8, 12) }),
    performance({ date: '2031-12-10', lift: 'pin-press', label: 'Pin press', sets: [lb(135, 8), lb(135, 7), lb(135, 6)], target: target(3, 5, 8) }),
  ];
  await seed(request, docs(putPrograms(version), putPerformances(...lastTime)));
  await watchForDiary(context);
  await page.clock.install({ time: at(DAY) });
  await openControlled(page);
  await tab(page, 'Train').click();
  await expect(weekCount(page)).toHaveText('0 of 1 done', { timeout: 15_000 });

  await context.setOffline(true);
  await page.reload();
  await tab(page, 'Train').click();
  await expect(dayRow(page, /^Push day/)).toBeVisible();

  await openDay(page, 'Push day');
  await expect(page.locator('.train').getByRole('heading', { level: 3 }), 'a superset is labelled, as plain information').toHaveText(['Superset · 3 rounds · rest 75s']);
  const flyRow = row(page, /^Cable fly/);
  await expect(flyRow).toContainText('40 lb × 12/11/10 · Dec 10');
  await expect(flyRow).toContainText('3 × 8–12');
  await expect(flyRow).toHaveAccessibleName(/0 of 3 logged/);
  await expect(page.locator('[aria-current="step"]'), 'nothing is highlighted as current').toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Start|Finish|Plan)$/ }), 'nothing to start, finish or walk').toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);

  // The plan's last exercise first.
  await openExercise(page, 'Pin press', 'Set 1 of 3');
  await expect(card(page)).toContainText('5–8 reps');
  await expect(card(page)).toContainText('Last 135 lb × 8/7/6 · Dec 10');
  await expect(load(page)).toHaveValue('135');
  await expect(reps(page)).toHaveValue('8');

  // A warm-up does not count as a set and fills no dot.
  await load(page).fill('95');
  await page.getByRole('button', { name: 'Warm-up', exact: true }).click();
  await logSet(page);
  await expect(toast(page, 'Pin press logged')).toBeVisible();
  await expectCard(page, 'Pin press', 'Set 1 of 3');
  await expect(page.getByRole('button', { name: 'Warm-up', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(load(page), 'the working weight comes back after a warm-up').toHaveValue('135');

  // After a set it stays here with the next one filled in, and says nothing about what comes next.
  await logSet(page);
  await expectCard(page, 'Pin press', 'Set 2 of 3');
  await expect(load(page)).toHaveValue('135');
  await expect(reps(page)).toHaveValue('7');
  await expect(page.getByText('Next:')).toHaveCount(0);
  await expect(page.getByRole('timer')).toHaveCount(0);

  await back(page);
  await expect(title(page, 'Push day')).toBeVisible();
  await expect(row(page, /^Pin press/), 'only a working set fills a dot').toHaveAccessibleName(/1 of 3 logged/);

  // The superset's second lift before its first, and then the first.
  await openExercise(page, 'Meadows row', 'Set 1 of 3');
  await logSet(page);
  await expectCard(page, 'Meadows row', 'Set 2 of 3');
  await back(page);
  await openExercise(page, 'Cable fly', 'Set 1 of 3');
  await logSet(page);
  await expectCard(page, 'Cable fly', 'Set 2 of 3');
  await back(page);
  await expect(row(page, /^Meadows row/)).toHaveAccessibleName(/1 of 3 logged/);
  await expect(row(page, /^Cable fly/)).toHaveAccessibleName(/1 of 3 logged/);

  // And back to the first he opened, its count its own.
  await openExercise(page, 'Pin press', 'Set 2 of 3');

  await load(page).fill('140');
  await page.getByRole('button', { name: 'More reps' }).click();
  await tab(page, 'Diary').click();
  await expect(page.getByRole('region', { name: 'Breakfast' })).toBeVisible();
  await tab(page, 'Train').click();
  await expectCard(page, 'Pin press', 'Set 2 of 3');
  await expect(load(page), 'typed digits survive a tab switch').toHaveValue('140');
  await expect(reps(page)).toHaveValue('8');

  await page.reload();
  await expect(weekCount(page), 'a reload right after a set lands on Train\'s list').toHaveText('1 of 1 done');
  expect(await sawDiary(page), 'and never shows the Diary').toBe(false);
  await openDay(page, 'Push day');
  await openExercise(page, 'Pin press', 'Set 2 of 3');
  await expect(load(page), 'typed digits survive a reload').toHaveValue('140');
  await logSet(page);
  await expectCard(page, 'Pin press', 'Set 3 of 3');
  await expect(load(page), 'the next set takes the load of the last one today').toHaveValue('140');
  await back(page);

  await openExercise(page, 'Meadows row', 'Set 2 of 3');
  await load(page).fill('62.5');
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(weekCount(reopened)).toHaveText('1 of 1 done');
  expect(await sawDiary(reopened), 'nor does a relaunch').toBe(false);
  await openDay(reopened, 'Push day');
  await openExercise(reopened, 'Meadows row', 'Set 2 of 3');
  await expect(load(reopened), 'typed digits survive the page being killed').toHaveValue('62.5');
  await logSet(reopened);
  await expectCard(reopened, 'Meadows row', 'Set 3 of 3');
  expect(reachesServer(DAY), 'nothing has reached the server yet').toEqual([]);
  await expect(waiting(reopened)).toBeVisible();

  await context.setOffline(false);
  await expect(waiting(reopened)).toBeHidden({ timeout: 20_000 });
  expect(reachesServer(DAY)).toEqual([
    { lift: 'cable-fly', slot: 'a1', planned: undefined, sets: [{ load: { kind: 'weight', amount: 40, unit: 'lb' }, reps: { kind: 'total', reps: 12 }, warmup: false }] },
    {
      lift: 'meadows-row',
      slot: 'a2',
      planned: undefined,
      sets: [
        { load: { kind: 'weight', amount: 60, unit: 'lb' }, reps: { kind: 'total', reps: 10 }, warmup: false },
        { load: { kind: 'weight', amount: 62.5, unit: 'lb' }, reps: { kind: 'total', reps: 9 }, warmup: false },
      ],
    },
    {
      lift: 'pin-press',
      slot: 'b1',
      planned: undefined,
      sets: [
        { load: { kind: 'weight', amount: 95, unit: 'lb' }, reps: { kind: 'total', reps: 8 }, warmup: true },
        { load: { kind: 'weight', amount: 135, unit: 'lb' }, reps: { kind: 'total', reps: 8 }, warmup: false },
        { load: { kind: 'weight', amount: 140, unit: 'lb' }, reps: { kind: 'total', reps: 8 }, warmup: false },
      ],
    },
  ]);
  const onServer = sessionsOn(DAY);
  expect(onServer).toHaveLength(1);
  expect(onServer[0]).toMatchObject({ programId: version.id, day: { key: 'push', label: 'Push day' } });
  expect(onServer[0]?.finishedAt).toBeUndefined();
});

test('a swap prefills from the new lift, holds with no set under it, and both last-times read right next week', async ({ page, request }) => {
  const MONDAY = '2031-11-03';
  const DAY = '2031-11-05';
  const press = slot('a1', 'landmine-press', 3, { label: 'Landmine press', target: target(3, 8, 12) });
  const cableRow = slot('a2', 'cable-row', 3, { label: 'Cable row', target: target(3, 8, 12), swaps: [{ liftId: lift('dumbbell-row'), label: 'Dumbbell row', cue: 'Invented cue for the swap.' }] });
  const version = program(MONDAY, [{ key: 'pair', label: 'Pair day', weekday: 3, blocks: [liftsBlock('pair', [press, cableRow], { restSeconds: 60 })] }]);
  const earlier = '2031-10-29';
  const history = [
    performance({ date: earlier, lift: 'landmine-press', label: 'Landmine press', sets: [lb(50, 10), lb(50, 10), lb(50, 9)] }),
    performance({ date: earlier, lift: 'cable-row', label: 'Cable row', sets: [lb(70, 10), lb(70, 10), lb(70, 10)] }),
    performance({ date: '2031-10-25', lift: 'dumbbell-row', label: 'Dumbbell row', sets: [kg(30, 12), kg(30, 11)] }),
  ];
  await seed(request, docs(putPrograms(version), putPerformances(...history)));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Pair day');

  // The first slot goes to a name typed on the spot, before any set.
  await openExercise(page, 'Landmine press', 'Set 1 of 3');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Swap' });
  await expect(sheet.getByRole('list', { name: 'Listed for this slot' })).toHaveCount(0);
  await sheet.getByLabel('Another lift').fill('Zottman press (seated)');
  await sheet.getByRole('button', { name: 'Use "Zottman press (seated)"' }).click();
  await expectCard(page, 'Zottman press (seated)', 'Set 1 of 3');
  await expect(card(page), 'a lift never done has no last line').not.toContainText('Last ');
  await expect(load(page), 'and never the old lift’s weight').toHaveValue('');

  // A swap writes nothing, and holds through Back and a reload.
  await back(page);
  await expect(row(page, /^Zottman press/)).toBeVisible();
  expect(await countOnPhone(page, 'outbox'), 'a swap with no set stores nothing').toBe(0);
  await page.reload();
  await tab(page, 'Train').click();
  await openDay(page, 'Pair day');
  await openExercise(page, 'Zottman press (seated)', 'Set 1 of 3');
  await load(page).fill('35');
  await logSet(page);
  await expectCard(page, 'Zottman press (seated)', 'Set 2 of 3');
  await expect(load(page)).toHaveValue('35');
  await logSet(page);
  await expectCard(page, 'Zottman press (seated)', 'Set 3 of 3');
  await back(page);

  // The second slot swaps after a set, from the listed choice.
  await openExercise(page, 'Cable row', 'Set 1 of 3');
  await logSet(page);
  await expectCard(page, 'Cable row', 'Set 2 of 3');
  await expect(load(page)).toHaveValue('70');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Dumbbell row' }).click();
  await expectCard(page, 'Dumbbell row', 'Set 2 of 3');
  await expect(card(page)).toContainText('Last 30 kg × 12/11 · Oct 25');
  await expect(load(page), 'the swapped lift’s own weight').toHaveValue('30');
  await expect(unit(page)).toHaveText('kg');
  await page.getByRole('button', { name: 'Cue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Cue' }).getByText('Invented cue for the swap.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Cue' }).getByRole('button', { name: 'Done' }).click();
  await logSet(page);
  await expectCard(page, 'Dumbbell row', 'Set 3 of 3');
  await expect(load(page)).toHaveValue('30');
  await logSet(page);
  await expectCard(page, 'Dumbbell row', 'Extra set');
  await back(page);
  await expect(row(page, /^Dumbbell row/), 'the day says what he is doing there').toHaveAccessibleName(/3 of 3 logged/);

  await openExercise(page, 'Zottman press (seated)', 'Set 3 of 3');
  await logSet(page);
  await expect
    .poll(() => reachesServer(DAY).map((p) => [p.lift, p.slot, p.planned, p.sets.length]))
    .toEqual([
      ['cable-row', 'a2', undefined, 1],
      ['dumbbell-row', 'a2', 'cable-row', 2],
      ['zottman-press', 'a1', 'landmine-press', 3],
    ]);

  // Next week, the first slot was swapped for the whole of last time, and the second only in part.
  await back(page);
  await back(page);
  await page.clock.fastForward(7 * 24 * HOUR);
  await tab(page, 'Diary').click();
  await tab(page, 'Train').click();
  await openDay(page, 'Pair day');
  await openExercise(page, 'Landmine press', 'Set 1 of 3');
  await expect(card(page)).toContainText('Last 50 lb × 10/10/9 · Oct 29');
  await expect(card(page)).toContainText('Last time: Zottman press (seated)');
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
  await expectCard(page, 'Zottman press (seated)', 'Set 1 of 3');
  await expect(card(page)).toContainText('Last 35 lb × 8/8/8 · Nov 5');
  await expect(load(page)).toHaveValue('35');
  await back(page);

  await openExercise(page, 'Cable row', 'Set 1 of 3');
  await expect(card(page)).toContainText('Last 70 lb × 10 · Nov 5');
  await expect(card(page), 'he did the planned lift that day too').not.toContainText('Last time:');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Dumbbell row' }).click();
  await expect(card(page)).toContainText('Last 30 kg × 12/11 · Nov 5');
});

test('kg and lb in one lift, bodyweight, a band, per-side, an extra set, a skip with undo, a checklist, cardio, an edit, a delete and notes', async ({ page, request }) => {
  const MONDAY = '2031-10-20';
  const DAY = '2031-10-22';
  const version = program(MONDAY, [
    {
      key: 'mixed',
      label: 'Mixed day',
      weekday: 3,
      blocks: [
        checklist('warm', { title: 'Warm up', items: ['Band pull-apart', 'Easy row'] }),
        liftsBlock('pair', [slot('a1', 'goblet-squat', 3, { label: 'Goblet squat', target: target(3, 8, 12) }), slot('a2', 'pallof-press', 2, { label: 'Pallof press', target: target(2, 10, 10, { perSide: 'right-first' }) })], { restSeconds: 60 }),
        liftsBlock('band', [slot('b1', 'band-row', 2, { label: 'Band row', target: target(2, 15, 20, { load: 'band' }) })], { restSeconds: 30 }),
        liftsBlock('body', [slot('c1', 'chin-up', 2, { label: 'Chin-up', target: target(2, 5, 8, { load: 'bodyweight' }) })], { restSeconds: 90 }),
        liftsBlock('carry', [slot('d1', 'sled-push', 1, { label: 'Sled push', target: target(1, 1, 1), setPrompt: 'Distance' })]),
        liftsBlock('skipper', [slot('e1', 'suitcase-carry', 1, { label: 'Suitcase carry', target: target(1, 1, 1) })]),
        cardio('bike', { title: 'Easy bike', note: 'Invented note on the ride.' }),
        liftsBlock('extra', [slot('f1', 'dead-bug', 2, { label: 'Dead bug', target: target(2, 10, 10, { load: 'bodyweight' }) })], { title: 'Extras', optional: true }),
      ],
    },
  ]);
  await seed(request, docs(putPrograms(version), [weighInOn(DAY)]));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Mixed day');

  // A checklist is one row that opens, with one Done and an undo.
  const warmUp = page.locator('details').filter({ hasText: 'Warm up · 2 moves' });
  await expect(warmUp.getByText('Band pull-apart')).toBeHidden();
  await warmUp.locator('summary').click();
  await expect(warmUp.getByText('Band pull-apart')).toBeVisible();
  await warmUp.getByRole('button', { name: 'Warm up done' }).click();
  await expect(warmUp.locator('summary')).toContainText('Done');
  await expect(warmUp.getByRole('button', { name: 'Warm up done' })).toHaveCount(0);
  await toast(page, 'Warm up done').getByRole('button', { name: 'Undo' }).click();
  await warmUp.getByRole('button', { name: 'Warm up done' }).click();
  await expect(warmUp.locator('summary')).toContainText('Done');

  // Log set stays off until a load is typed. The steppers go by 2.5 lb, then 1 kg once he switches.
  await openExercise(page, 'Goblet squat', 'Set 1 of 3');
  await expect(logButton(page)).toBeDisabled();
  await expect(reps(page), 'reps start at the bottom of the range').toHaveValue('8');
  await load(page).fill('50');
  await expect(page.locator('.quiet-actions button'), 'the same five actions').toHaveText(['Swap', 'Skip', 'Note', 'Cue', 'Warm-up']);
  await page.getByRole('button', { name: 'More load' }).click();
  await expect(load(page)).toHaveValue('52.5');
  await page.getByRole('button', { name: 'Less load' }).click();
  await expect(load(page)).toHaveValue('50');
  await logSet(page);

  // kg in the same lift, inherited by the next set, with the number staying as typed.
  await expectCard(page, 'Goblet squat', 'Set 2 of 3');
  await unit(page).click();
  await expect(unit(page)).toHaveText('kg');
  await expect(load(page)).toHaveValue('50');
  await load(page).fill('22');
  await page.getByRole('button', { name: 'More load' }).click();
  await expect(load(page)).toHaveValue('23');
  await logSet(page);
  await expectCard(page, 'Goblet squat', 'Set 3 of 3');
  await expect(load(page)).toHaveValue('23');
  await expect(unit(page)).toHaveText('kg');
  await logSet(page);
  await expectCard(page, 'Goblet squat', 'Extra set');
  await load(page).fill('1');
  await page.getByRole('button', { name: 'Less load' }).click();
  await expect(page.locator('.set-row-text'), 'minus past the last step is bodyweight').toHaveText('Bodyweight');
  await expect(logButton(page)).toBeEnabled();
  await back(page);

  // A per-side set shows two rows in the order the target names, and rest is plain text under Cue.
  await openExercise(page, 'Pallof press', 'Set 1 of 2');
  await expect(page.locator('.set-row-unit.side')).toHaveText(['R', 'L']);
  await load(page).fill('25');
  await expect(page.getByLabel('Left reps', { exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: 'Less left reps' }).click();
  await page.getByRole('button', { name: 'Cue', exact: true }).click();
  const cue = page.getByRole('dialog', { name: 'Cue' });
  await expect(cue.getByText('Rest 60s')).toBeVisible();
  await expect(cue.getByText('Per side, right first')).toBeVisible();
  await cue.getByRole('button', { name: 'Done' }).click();
  await logSet(page);
  await expectCard(page, 'Pallof press', 'Set 2 of 2');
  await back(page);

  // A band load is a label.
  await openExercise(page, 'Band row', 'Set 1 of 2');
  await expect(load(page)).toHaveCount(0);
  await expect(logButton(page)).toBeDisabled();
  await page.getByLabel('Band', { exact: true }).fill('green');
  await logSet(page);
  await expectCard(page, 'Band row', 'Set 2 of 2');
  await expect(page.getByLabel('Band', { exact: true })).toHaveValue('green');
  await logSet(page);
  await expectCard(page, 'Band row', 'Extra set');
  await back(page);

  // A bodyweight load hides the load row, with a way to add weight. Past the prescription it keeps logging, as an extra set.
  await openExercise(page, 'Chin-up', 'Set 1 of 2');
  await expect(load(page)).toHaveCount(0);
  await expect(page.getByText('Bodyweight', { exact: true })).toBeVisible();
  await logSet(page);
  await expectCard(page, 'Chin-up', 'Set 2 of 2');
  await page.getByRole('button', { name: 'Add weight' }).click();
  await load(page).fill('10');
  await logSet(page);
  await expectCard(page, 'Chin-up', 'Extra set');
  await expect(load(page), 'an extra set takes the last load').toHaveValue('10');
  await logSet(page);
  await expect(page.getByRole('group', { name: "Today's sets" }).getByRole('button')).toHaveCount(3);
  await back(page);
  await expect(row(page, /^Chin-up/), 'an extra set adds its own dot').toHaveAccessibleName(/3 of 3 logged/);

  // A set prompt lands on the set, and an exercise with nothing behind it has no Cue to open.
  await openExercise(page, 'Sled push', 'Set 1 of 1');
  await expect(page.getByRole('button', { name: 'Cue', exact: true })).toBeDisabled();
  await load(page).fill('90');
  await page.getByLabel('Distance').fill('Forty metres');
  await logSet(page);
  await expectCard(page, 'Sled push', 'Extra set');
  await back(page);

  // A skip goes back to the day, marks the row and undoes, and holds its note.
  await openExercise(page, 'Suitcase carry', 'Set 1 of 1');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('dialog', { name: 'Skip Suitcase carry' }).getByRole('button', { name: 'Skip it' }).click();
  await expect(title(page, 'Mixed day')).toBeVisible();
  await expect(row(page, /^Suitcase carry/)).toContainText('Skipped');
  await toast(page, 'Skipped Suitcase carry').getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, /^Suitcase carry/)).not.toContainText('Skipped');
  await openExercise(page, 'Suitcase carry', 'Set 1 of 1');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const skip = page.getByRole('dialog', { name: 'Skip Suitcase carry' });
  await skip.getByLabel('Why (optional)').fill('Invented reason for skipping.');
  await skip.getByRole('button', { name: 'Skip it' }).click();
  await expect(row(page, /^Suitcase carry/)).toContainText('Skipped');

  // Cardio opens the existing logger, and that workout marks the row.
  await row(page, /^Easy bike/).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await expect(logger.getByText('Invented note on the ride.'), 'the words its row cuts to one line').toBeVisible();
  await logger.getByRole('button', { name: /^Stationary bike/ }).click();
  await logger.getByRole('button', { name: '15 min' }).click();
  await logger.getByRole('button', { name: 'Log workout' }).click();
  await expect(row(page, /^Easy bike/)).toContainText('Done');

  // An optional block folds at the end, and logs like any other.
  const optional = page.getByRole('region', { name: 'Optional' });
  await expect(row(page, /^Dead bug/)).toBeHidden();
  await optional.getByText('Optional', { exact: true }).click();
  await openExercise(page, 'Dead bug', 'Set 1 of 2');
  await logSet(page);
  await expectCard(page, 'Dead bug', 'Set 2 of 2');
  await back(page);
  await expect(row(page, /^Dead bug/), 'what he opened is still open').toHaveAccessibleName(/1 of 2 logged/);

  // Editing a set from its value, with an undo.
  await openExercise(page, 'Goblet squat', 'Extra set');
  const today = page.getByRole('group', { name: "Today's sets" }).getByRole('button');
  await expect(today).toHaveText(['50 lb × 8', '23 kg × 8', '23 kg × 8']);
  await today.first().click();
  const edit = page.getByRole('dialog', { name: 'Edit Goblet squat' });
  await expect(edit.getByLabel('Load', { exact: true })).toHaveValue('50');
  await edit.getByLabel('Load', { exact: true }).fill('55');
  await edit.getByLabel('Reps', { exact: true }).fill('9');
  await edit.getByRole('button', { name: 'Save set' }).click();
  await expect(today).toHaveText(['55 lb × 9', '23 kg × 8', '23 kg × 8']);
  await toast(page, 'Set updated').getByRole('button', { name: 'Undo' }).click();
  await expect(today).toHaveText(['50 lb × 8', '23 kg × 8', '23 kg × 8']);

  // Notes on the exercise and on the day.
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await note.getByLabel('On Goblet squat').fill('Invented note on the squat.');
  await note.getByRole('button', { name: 'Save note' }).click();
  await expect(toast(page, 'Note saved')).toBeVisible();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await note.getByRole('radio', { name: 'Today' }).click();
  await note.getByLabel("Today's note").fill('Invented note on the day.');
  await note.getByRole('button', { name: 'Save note' }).click();
  await expect(toast(page, 'Note saved')).toBeVisible();
  await back(page);

  // Deleting one, with an undo. Deleting the last of a slot takes its dots.
  await openExercise(page, 'Sled push', 'Extra set');
  await page.getByRole('group', { name: "Today's sets" }).getByRole('button', { name: /Forty metres/ }).click();
  await page.getByRole('dialog', { name: 'Edit Sled push' }).getByRole('button', { name: 'Delete set' }).click();
  await expectCard(page, 'Sled push', 'Set 1 of 1');
  await expect(page.getByRole('group', { name: "Today's sets" })).toHaveCount(0);
  await toast(page, 'Set deleted').getByRole('button', { name: 'Undo' }).click();
  await expectCard(page, 'Sled push', 'Extra set');
  await back(page);
  await expect(row(page, /^Sled push/)).toHaveAccessibleName(/1 of 1 logged/);

  await back(page);
  await expect(weekCount(page)).toHaveText('1 of 1 done');
  await expect(dayRow(page, /^Mixed day/)).toContainText('Done Wed');

  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(6);
  await expect.poll(() => sessionsOn(DAY)[0]?.note, { timeout: 15_000 }).toBe('Invented note on the day.');
  expect(sessionsOn(DAY)).toHaveLength(1);
  const held = new Map(stored('performance').filter((p) => p.date === DAY).map((p) => [p.liftId, p]));
  const units = held.get(lift('goblet-squat'))?.sets.map((set) => (set.load.kind === 'weight' ? `${set.load.amount} ${set.load.unit}` : null));
  expect(units, 'lb and kg in one lift, each as typed').toEqual(['50 lb', '23 kg', '23 kg']);
  expect(held.get(lift('goblet-squat'))?.note).toBe('Invented note on the squat.');
  expect(held.get(lift('pallof-press'))?.sets[0]?.reps).toEqual({ kind: 'sides', left: 9, right: 10 });
  expect(held.get(lift('band-row'))?.sets.map((set) => set.load)).toEqual([{ kind: 'band', label: 'green' }, { kind: 'band', label: 'green' }]);
  expect(held.get(lift('chin-up'))?.sets.map((set) => set.load)).toEqual([{ kind: 'bodyweight' }, { kind: 'weight', amount: 10, unit: 'lb' }, { kind: 'weight', amount: 10, unit: 'lb' }]);
  expect(held.get(lift('sled-push'))?.sets[0]?.note).toBe('Forty metres');
  const logged = sessionsOn(DAY)[0];
  expect(logged?.skips).toEqual([{ slotId: 'e1', note: 'Invented reason for skipping.' }]);
  expect(logged?.checked).toEqual(['warm']);
  expect(logged?.finishedAt).toBeUndefined();
});

test('opening a day writes nothing, and a day holds one session per date', async ({ page, request }) => {
  const MONDAY = '2031-10-13';
  const DAY = '2031-10-15';
  const version = program(MONDAY, [
    { key: 'lazy', label: 'Lazy day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) }), slot('a2', 'pin-press', 3, { label: 'Pin press', target: target(3, 5, 8) })])] },
    { key: 'other', label: 'Other day', weekday: 4, blocks: [liftsBlock('main', [slot('b1', 'pendlay-row', 3, { label: 'Pendlay row', target: target(3, 8, 12) })])] },
  ]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);

  await openDay(page, 'Lazy day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await load(page).fill('70');
  await back(page);
  await back(page);
  await expect(weekCount(page)).toHaveText('0 of 2 done');
  expect(await countOnPhone(page, 'outbox'), 'opening a day and an exercise and typing stores nothing').toBe(0);
  await expect(waiting(page)).toHaveCount(0);

  await openDay(page, 'Lazy day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await expect(load(page), 'typed digits wait through Back').toHaveValue('70');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await back(page);
  await openExercise(page, 'Pin press', 'Set 1 of 3');
  await load(page).fill('135');
  await logSet(page);
  await expectCard(page, 'Pin press', 'Set 2 of 3');
  await back(page);
  await back(page);
  await expect(dayRow(page, /^Lazy day/)).toContainText('Done Wed');
  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(2);
  expect(sessionsOn(DAY).map((s) => [s.day?.key, s.programId])).toEqual([['lazy', version.id]]);

  await openDay(page, 'Other day');
  await openExercise(page, 'Pendlay row', 'Set 1 of 3');
  await load(page).fill('95');
  await logSet(page);
  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(3);
  expect(sessionsOn(DAY).map((s) => s.day?.key).toSorted(), 'each day its own').toEqual(['lazy', 'other']);
  await back(page);
  await back(page);

  // The next date starts its count from nothing and makes its own.
  const NEXT = addDays(day(DAY), 1);
  await page.clock.fastForward(24 * HOUR);
  await openDay(page, 'Lazy day');
  await expect(row(page, /^Seal row/)).toHaveAccessibleName(/0 of 3 logged/);
  await expect(row(page, /^Seal row/)).toContainText('70 lb × 8 · Oct 15');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await expect.poll(() => sessionsOn(NEXT).length, { timeout: 15_000 }).toBe(1);
  expect(sessionsOn(DAY)).toHaveLength(2);
});

test('undoing or deleting the only set makes the day not done again, and the emptied session goes when it settles', async ({ page, request }) => {
  const MONDAY = '2031-10-06';
  const DAY = '2031-10-08';
  const version = program(MONDAY, [{ key: 'only', label: 'Only day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })])] }]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY, '09:00:00') });
  await openWeek(page);
  await openDay(page, 'Only day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await load(page).fill('70');

  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await toast(page, 'Seal row logged').getByRole('button', { name: 'Undo' }).click();
  await expectCard(page, 'Seal row', 'Set 1 of 3');
  await back(page);
  await back(page);
  await expect(weekCount(page)).toHaveText('0 of 1 done');
  await expect(dayRow(page, /^Only day/)).not.toContainText('Done');
  await expect.poll(() => countOnPhone(page, 'outbox'), { timeout: 15_000 }).toBe(0);
  expect(sessionsOn(DAY), 'undo took the session with it').toEqual([]);
  expect(reachesServer(DAY)).toEqual([]);

  await openDay(page, 'Only day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await load(page).fill('70');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await page.getByRole('group', { name: "Today's sets" }).getByRole('button').first().click();
  await page.getByRole('dialog', { name: 'Edit Seal row' }).getByRole('button', { name: 'Delete set' }).click();
  await expectCard(page, 'Seal row', 'Set 1 of 3');
  await back(page);
  await back(page);
  await expect(weekCount(page)).toHaveText('0 of 1 done');
  await expect.poll(() => sessionsOn(DAY).length, { timeout: 15_000 }).toBe(1);

  await page.clock.fastForward(6 * HOUR + 1000);
  await comeBackToApp(page);
  await expect.poll(() => sessionsOn(DAY).length, { timeout: 15_000, message: 'nothing in it, so settling removes it' }).toBe(0);
  expect(minutesOn(DAY)).toEqual([]);
});

for (const policy of ['activity-level', 'eat-back-workouts'] as const) {
  test(`under ${policy}, a settled workout runs first set to last, and lifting and cardio do not overlap`, async ({ page, request }) => {
    const MONDAY = policy === 'activity-level' ? '2031-09-15' : '2031-09-29';
    const DAY = addDays(day(MONDAY), 2);
    const version = program(MONDAY, [{ key: 'both', label: 'Lift and ride', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'front-squat', 2, { label: 'Front squat', target: target(2, 8, 12) })], { restSeconds: 90 }), cardio('ride', { title: 'Easy ride' })] }]);
    const goal: Mutation = {
      op: 'put',
      kind: 'goal',
      doc: {
        id: goalId(day(MONDAY)),
        effectiveFrom: day(MONDAY),
        policy: policy === 'activity-level' ? { kind: 'activity-level', level: 'moderate' } : { kind: 'eat-back-workouts', fraction: 1 },
        kgPerWeek: -0.45,
        macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 },
      },
    };
    const profile: Mutation = { op: 'put', kind: 'profile', doc: { id: PROFILE_ID, sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 } };
    await seed(request, docs(putPrograms(version), [profile, goal, weighInOn(DAY)]));
    await page.clock.install({ time: at(DAY, '09:00:00') });
    await page.goto('/');
    await expect(page.getByTestId('kcal-target')).toBeVisible({ timeout: 15_000 });
    const baseTarget = await page.getByTestId('kcal-target').textContent();

    await tab(page, 'Train').click();
    await openDay(page, 'Lift and ride');
    await openExercise(page, 'Front squat', 'Set 1 of 2');
    await load(page).fill('135');
    await logSet(page);
    await expectCard(page, 'Front squat', 'Set 2 of 2');
    await back(page);
    await page.clock.fastForward(30 * MINUTE);

    await row(page, /^Easy ride/).click();
    const logger = page.getByRole('dialog', { name: 'Add workout' });
    await logger.getByRole('region', { name: 'Walking' }).getByRole('button', { name: /^Walking, 3 mph/ }).click();
    await logger.getByLabel('Duration').fill('20');
    await logger.getByRole('button', { name: 'Log workout' }).click();
    await expect(row(page, /^Easy ride/)).toContainText('Done');
    await page.clock.fastForward(30 * MINUTE);

    await openExercise(page, 'Front squat', 'Set 2 of 2');
    await logSet(page);
    await expectCard(page, 'Front squat', 'Extra set');

    await page.clock.fastForward(6 * HOUR + 1000);
    await page.reload();
    const workouts = page.getByRole('region', { name: 'Workouts' });
    await expect(workouts.getByRole('button', { name: /^Lift and ride/ })).toContainText('40 min');
    await expect(workouts.getByRole('button', { name: /^Walking, 3 mph/ })).toContainText('20 min');
    await expect(workouts.getByRole('listitem'), 'two workouts').toHaveCount(2);

    await expect.poll(() => minutesOn(DAY).length, { timeout: 15_000 }).toBe(2);
    const finished = sessionsOn(DAY)[0];
    expect(finished?.finishedAt).toBeDefined();
    const lifted = stored('workout').filter((w) => finished !== undefined && w.id === sessionWorkoutId(finished));
    const walked = stored('workout').filter((w) => w.date === DAY && finished !== undefined && w.id !== sessionWorkoutId(finished));
    expect(lifted.map((w) => [w.name, w.minutes])).toEqual([['Lift and ride', 40]]);
    expect(walked.map((w) => w.minutes)).toEqual([20]);
    // 2.5 MET above resting for 40 minutes, and 2.8 for 20, at the trend weight the day holds.
    const kcalOf = (met: number, minutes: number, kg_: number) => Math.round((met * kg_ * minutes) / 60);
    const liftedKcal = lifted.map((w) => w.kcal)[0];
    const walkedKcal = walked.map((w) => w.kcal)[0];
    expect(liftedKcal).toBe(kcalOf(2.5, 40, lifted[0]?.kg ?? 0));
    expect(walkedKcal).toBe(kcalOf(2.8, 20, walked[0]?.kg ?? 0));
    // The day's total is the goal, which never moves, plus what the policy lets workouts add.
    const added = policy === 'activity-level' ? 0 : (liftedKcal ?? 0) + (walkedKcal ?? 0);
    await expect(page.getByTestId('kcal-target'), 'an activity level adds nothing, and eating back adds lifting and cardio, each once').toHaveText((Number(baseTarget?.replace(/,/g, '')) + added).toLocaleString('en-US'));
  });
}

test('a session idle six hours settles by itself at its last set, saying nothing, and a new set that date reopens it until the workout catches up', async ({ page, request }) => {
  const MONDAY = '2031-09-08';
  const DAY = '2031-09-10';
  const version = program(MONDAY, [{ key: 'solo', label: 'Solo day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })], { restSeconds: 90 })] }]);
  await seed(request, docs(putPrograms(version), [weighInOn(DAY)]));
  await page.clock.install({ time: at(DAY, '09:00:00') });
  await openWeek(page);
  await openDay(page, 'Solo day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await load(page).fill('70');
  await logButton(page).dblclick();
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await back(page);
  await expect(row(page, /^Seal row/), 'a double tap logs one set').toHaveAccessibleName(/1 of 3 logged/);
  await openExercise(page, 'Seal row', 'Set 2 of 3');
  await page.clock.fastForward(10 * MINUTE);
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 3 of 3');

  await page.clock.fastForward(5 * HOUR);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Breakfast' }), 'past three hours, a reload lands on the Diary').toBeVisible();
  await expect(page.getByRole('region', { name: 'Workouts' }).getByRole('button', { name: /^Solo day/ }), 'not settled yet').toHaveCount(0);

  await page.clock.fastForward(61 * MINUTE);
  await page.reload();
  const workouts = page.getByRole('region', { name: 'Workouts' });
  await expect(workouts.getByRole('button', { name: /^Solo day/ })).toContainText('10 min');
  await expect(page.getByText(/Finished/), 'nothing on screen mentions it').toHaveCount(0);

  await tab(page, 'Train').click();
  await expect(dayRow(page, /^Solo day/)).toContainText('Done Wed');
  await expect.poll(() => minutesOn(DAY), { timeout: 15_000 }).toEqual([10]);
  const settled = sessionsOn(DAY)[0];
  const tapped = stored('performance').find((p) => p.date === DAY)?.sets.at(-1)?.at;
  expect(settled?.finishedAt, 'at the last set’s time').toBe(tapped);

  // A new set the same date reopens it, in the same session, and the workout waits for the next settle.
  await openDay(page, 'Solo day');
  await openExercise(page, 'Seal row', 'Set 3 of 3');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Extra set');
  await expect.poll(() => sessionsOn(DAY)[0]?.finishedAt, { timeout: 15_000 }).toBeUndefined();
  expect(sessionsOn(DAY).map((s) => s.id)).toEqual([settled?.id]);
  expect(minutesOn(DAY)).toEqual([10]);

  await page.clock.fastForward(6 * HOUR + 1000);
  await page.reload();
  await expect(workouts.getByRole('button', { name: /^Solo day/ })).toContainText('371 min');
  await expect.poll(() => minutesOn(DAY), { timeout: 15_000 }).toEqual([371]);
  expect(sessionsOn(DAY)[0]?.finishedAt, 'at the new last set').toBe(stored('performance').find((p) => p.date === DAY)?.sets.at(-1)?.at);
});

test('a version published while a day holds a set changes nothing on it, and the next date uses it', async ({ page, request }) => {
  const MONDAY = '2031-08-18';
  const DAY = '2031-08-20';
  const slots = [slot('a1', 'trap-bar-deadlift', 3, { label: 'Trap bar deadlift', target: target(3, 8, 12) })];
  const older = program(MONDAY, [{ key: 'pull', label: 'Pull day', weekday: 3, blocks: [liftsBlock('main', slots, { restSeconds: 90 })] }]);
  const newer = program(DAY, [{ key: 'pull', label: 'Pull day, new', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'trap-bar-deadlift', 5, { label: 'Deadlift, rewritten', target: target(5, 3, 5) })], { restSeconds: 180 })] }]);
  await seed(request, putPrograms(older));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Pull day');
  await openExercise(page, 'Trap bar deadlift', 'Set 1 of 3');
  await load(page).fill('225');
  await logSet(page);
  await expectCard(page, 'Trap bar deadlift', 'Set 2 of 3');

  await seed(request, putPrograms(newer));
  const before = await countOnPhone(page, 'program');
  await logSet(page);
  await expect.poll(() => countOnPhone(page, 'program'), { timeout: 15_000 }).toBe(before + 1);

  await expectCard(page, 'Trap bar deadlift', 'Set 3 of 3');
  await expect(card(page)).toContainText('8–12 reps');
  await page.getByRole('button', { name: 'Cue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Cue' }).getByText('Rest 90s'), 'the pinned rest, not the new one').toBeVisible();
  await page.getByRole('dialog', { name: 'Cue' }).getByRole('button', { name: 'Done' }).click();
  await back(page);
  await expect(title(page, 'Pull day'), 'the day still reads as he pinned it').toBeVisible();
  await expect(row(page, /^Trap bar deadlift/)).toContainText('3 × 8–12');
  await back(page);
  await expect(dayRow(page, /^Pull day, new/), 'and the week reads the version in effect').toContainText('Done Wed');

  await page.reload();
  await dayRow(page, /^Pull day, new/).click();
  await expect(title(page, 'Pull day'), 'a reload changes nothing').toBeVisible();
  await back(page);

  const NEXT = addDays(day(DAY), 1);
  await page.clock.fastForward(24 * HOUR);
  await openDay(page, 'Pull day, new');
  await openExercise(page, 'Deadlift, rewritten', 'Set 1 of 5');
  await expect(card(page)).toContainText('3–5 reps');
  await logSet(page);
  await expect.poll(() => sessionsOn(NEXT).map((s) => s.programId), { timeout: 15_000 }).toEqual([newer.id]);
  expect(sessionsOn(DAY).map((s) => s.programId)).toEqual([older.id]);
});

test('a version published while a day with nothing logged is open moves it, and the first set pins that one', async ({ page, request }) => {
  const MONDAY = '2031-08-11';
  const DAY = '2031-08-13';
  const older = program(MONDAY, [{ key: 'move', label: 'Moving day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })])] }]);
  const newer = program(DAY, [{ key: 'move', label: 'Moved day', weekday: 3, blocks: [liftsBlock('main', [slot('b1', 'pin-press', 3, { label: 'Pin press', target: target(3, 5, 8) })])] }]);
  await seed(request, putPrograms(older));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Moving day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');

  await seed(request, putPrograms(newer));
  await comeBackToApp(page);
  await expect(title(page, 'Moved day'), 'an exercise the plan no longer holds leaves him on the day').toBeVisible({ timeout: 15_000 });
  await expect(row(page, /^Seal row/)).toHaveCount(0);
  expect(await countOnPhone(page, 'outbox')).toBe(0);

  await openExercise(page, 'Pin press', 'Set 1 of 3');
  await load(page).fill('135');
  await logSet(page);
  await expect.poll(() => sessionsOn(DAY).map((s) => s.programId), { timeout: 15_000 }).toEqual([newer.id]);
});

test('a reload lands on Train for three hours after a set, and on the Diary otherwise', async ({ page, request }) => {
  const MONDAY = '2031-08-04';
  const DAY = '2031-08-06';
  const version = program(MONDAY, [{ key: 'land', label: 'Landing day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })])] }]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY, '10:00:00') });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Breakfast' }), 'no set, so the Diary').toBeVisible({ timeout: 15_000 });

  await tab(page, 'Train').click();
  await openDay(page, 'Landing day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Breakfast' }), 'opening an exercise is not training').toBeVisible();

  await tab(page, 'Train').click();
  await openDay(page, 'Landing day');
  await openExercise(page, 'Seal row', 'Set 1 of 3');
  await load(page).fill('70');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 3');
  await page.clock.fastForward(2 * HOUR);
  await page.reload();
  await expect(dayRow(page, /^Landing day/), 'the list, not the exercise he left').toContainText('Done Wed');
  await expect(card(page)).toHaveCount(0);

  await page.clock.fastForward(HOUR);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Breakfast' })).toBeVisible();
});

test('a set past midnight lands on the new date, with a session of its own', async ({ page, request }) => {
  const MONDAY = '2031-07-28';
  const DAY = '2031-07-30';
  const version = program(MONDAY, [{ key: 'late', label: 'Late day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pendlay-row', 2, { label: 'Pendlay row', target: target(2, 8, 12) })], { restSeconds: 60 })] }]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY, '23:50:00') });
  await openWeek(page);
  await openDay(page, 'Late day');
  await openExercise(page, 'Pendlay row', 'Set 1 of 2');
  await load(page).fill('95');
  await logSet(page);
  await expectCard(page, 'Pendlay row', 'Set 2 of 2');

  await page.clock.fastForward(20 * MINUTE);
  await expectCard(page, 'Pendlay row', 'Set 1 of 2');
  await expect(card(page)).toContainText('Last 95 lb × 8 · Jul 30');
  await logSet(page);
  const NEXT = addDays(day(DAY), 1);
  await expect.poll(() => [reachesServer(DAY).length, reachesServer(NEXT).length], { timeout: 15_000 }).toEqual([1, 1]);
  expect(sessionsOn(NEXT).map((s) => s.date)).toEqual([NEXT]);
});

test('a session pinned to a version this phone does not hold reads the version in effect, and still takes sets', async ({ page, request }) => {
  const MONDAY = '2031-07-21';
  const DAY = '2031-07-23';
  const unheld = program('2031-07-01', [{ key: 'now', blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3)])] }]);
  const pinned = { ...session({ date: day(DAY), day: { key: dayKey('now'), label: 'Now day' }, startedAt: ms(at(DAY).getTime()) }), programId: unheld.id };
  await seed(request, docs(putPrograms(program(MONDAY, [{ key: 'now', label: 'Now day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3, { label: 'Pin press' })])] }])), [{ op: 'put', kind: 'session', doc: pinned }]));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Now day');
  await openExercise(page, 'Pin press', 'Set 1 of 3');
  await load(page).fill('135');
  await logSet(page);
  await expectCard(page, 'Pin press', 'Set 2 of 3');
  await expect.poll(() => stored('performance').filter((p) => p.date === DAY).map((p) => p.sessionId), { timeout: 15_000 }).toEqual([pinned.id]);
});

test('Tell the coach writes a loose note from the Coach sheet, with an undo', async ({ page, request }) => {
  const MONDAY = '2031-07-14';
  const DAY = '2031-07-16';
  const version = program(MONDAY, [{ key: 'one', label: 'One day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3, { label: 'Pin press' })])] }]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY) });
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(weekCount(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'More' }).getByRole('button'), 'no weigh-in today, so its row is there').toHaveText(['Coach', 'Progress', 'Weigh in']);

  const openCoach = () => page.getByRole('button', { name: /^Coach/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Coach' });
  await openCoach();
  await expect(sheet.getByRole('button', { name: 'Save note' })).toBeDisabled();
  await sheet.getByLabel('Tell the coach').fill('Invented line one.');
  await sheet.getByRole('button', { name: 'Save note' }).click();
  await toast(page, 'Saved for the coach').getByRole('button', { name: 'Undo' }).click();

  await openCoach();
  await sheet.getByLabel('Tell the coach').fill('Invented line two.');
  await sheet.getByRole('button', { name: 'Save note' }).click();
  await expect(toast(page, 'Saved for the coach')).toBeVisible();
  await expect.poll(() => stored('trainingNote').filter((n) => n.date === DAY).map((n) => n.text), { timeout: 15_000 }).toEqual(['Invented line two.']);
});

test('Back lands where he left the day, and a tap on Train goes up to the list', async ({ page, request }) => {
  const MONDAY = '2031-07-07';
  const DAY = '2031-07-09';
  const lifts = Array.from({ length: 12 }, (_, i) => slot(`s${i}`, `invented-lift-${i}`, 3, { label: `Invented lift ${i}`, target: target(3, 8, 12) }));
  const version = program(MONDAY, [{ key: 'long', label: 'Long day', weekday: 3, blocks: lifts.map((one, i) => liftsBlock(`b${i}`, [one])) }]);
  await seed(request, putPrograms(version));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Long day');
  const far = row(page, /^Invented lift 11/);
  await far.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await far.click();
  await expectCard(page, 'Invented lift 11', 'Set 1 of 3');
  await back(page);
  await expect(title(page, 'Long day')).toBeAttached();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  await far.click();
  await tab(page, 'Train').click();
  await expect(weekCount(page)).toBeVisible();
});

test('a copy of the pinned version replaced under a day moves its rows, and the sets already logged stay stored', async ({ page, request }) => {
  const MONDAY = '2031-06-30';
  const DAY = '2031-07-02';
  const trouble: string[] = [];
  page.on('pageerror', (err) => trouble.push(err.message));
  const first = program(MONDAY, [{ key: 'moved', label: 'Moved day', weekday: 3, blocks: [liftsBlock('pair', [slot('a1', 'seal-row', 2, { label: 'Seal row', target: target(2, 8, 12) }), slot('a2', 'pendlay-row', 2, { label: 'Pendlay row', target: target(2, 8, 12) })])] }]);
  const replaced = program(MONDAY, [{ key: 'moved', label: 'Moved day', weekday: 3, blocks: [liftsBlock('main', [slot('b1', 'pin-press', 2, { label: 'Pin press', target: target(2, 5, 5) })])] }]);
  await seed(request, putPrograms(first));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await openDay(page, 'Moved day');
  await openExercise(page, 'Seal row', 'Set 1 of 2');
  await load(page).fill('70');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Set 2 of 2');
  await back(page);
  await openExercise(page, 'Pendlay row', 'Set 1 of 2');
  await load(page).fill('95');
  await logSet(page);
  await expectCard(page, 'Pendlay row', 'Set 2 of 2');
  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(2);

  await seed(request, putPrograms(replaced));
  await page.reload();
  await openDay(page, 'Moved day');
  await expect(row(page, /^Pin press/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.train')).not.toContainText('Seal row');
  await openExercise(page, 'Pin press', 'Set 1 of 2');
  await load(page).fill('135');
  await logSet(page);
  await expect
    .poll(() => reachesServer(DAY).map((p) => [p.lift, p.sets.length]), { timeout: 15_000 })
    .toEqual([
      ['pendlay-row', 1],
      ['pin-press', 1],
      ['seal-row', 1],
    ]);
  expect(trouble).toEqual([]);
});
