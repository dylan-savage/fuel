/**
 * Logging at the gym and finishing, on a production build. Each test keeps to its own invented
 * week, later than any other spec's clock and earlier than the test before it, so a session one
 * leaves open is still in the future for the next and nothing settles it.
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

const card = (page: Page) => page.getByRole('region', { name: 'Set', exact: true });
const plan = (page: Page) => page.locator('.session-plan');
const planRow = (page: Page, name: RegExp) => plan(page).getByRole('button', { name });
const logButton = (page: Page) => page.getByRole('button', { name: 'Log set' });
const finishButton = (page: Page) => page.getByRole('button', { name: 'Finish', exact: true });
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

async function expectCard(page: Page, name: string, round: string) {
  await expect(card(page).getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByTestId('round')).toHaveText(round);
}

const logSet = (page: Page) => logButton(page).click();

async function logExpecting(page: Page, name: string, round: string) {
  await expectCard(page, name, round);
  await logSet(page);
}

const startButton = (page: Page) => page.getByRole('region', { name: 'Next day' }).getByRole('button', { name: 'Start', exact: true });

async function openWeek(page: Page) {
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(startButton(page)).toBeVisible({ timeout: 15_000 });
}

function stubWakeLock(context: BrowserContext, behaviour: 'grant' | 'refuse') {
  return context.addInitScript((mode) => {
    const log: string[] = [];
    Object.defineProperty(window, 'wakeLockLog', { value: log });
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          log.push('request');
          if (mode === 'refuse') return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
          return Promise.resolve({
            released: false,
            release() {
              log.push('release');
              return Promise.resolve();
            },
          });
        },
      },
    });
  }, behaviour);
}

const wakeLockLog = (page: Page) => page.evaluate((): unknown => Reflect.get(window, 'wakeLockLog'));

/** Notes on the root element if the Diary was ever on screen, which a reload during a session must not do. */
function watchForDiary(context: BrowserContext) {
  return context.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Breakfast"]') !== null) document.documentElement.dataset.sawDiary = 'yes';
    }).observe(document, { subtree: true, childList: true });
  });
}

const sawDiary = (page: Page) => page.evaluate(() => document.documentElement.dataset.sawDiary === 'yes');

const docs = (...lists: readonly (readonly Mutation[])[]) => lists.flat();
const putPrograms = (...doc: readonly ReturnType<typeof program>[]) => doc.map((d): Mutation => ({ op: 'put', kind: 'program', doc: d }));
const putPerformances = (...doc: readonly ReturnType<typeof performance>[]) => doc.map((d): Mutation => ({ op: 'put', kind: 'performance', doc: d }));

function reachesServer(date: string) {
  return stored('performance')
    .filter((p) => p.date === date)
    .map((p) => ({ lift: p.liftId, slot: p.slotId, planned: p.plannedLiftId, sets: p.sets.map((set) => ({ load: set.load, reps: set.reps, warmup: set.warmup === true })) }))
    .toSorted((a, b) => a.lift.localeCompare(b.lift));
}

test('logs offline through a tab switch, a reload and a page kill mid-set, then reaches the server', async ({ page, context, request }) => {
  const MONDAY = '2031-12-15';
  const DAY = '2031-12-17';
  const version = program(MONDAY, [
    {
      key: 'push',
      label: 'Push day',
      weekday: 3,
      blocks: [
        liftsBlock('pair', [slot('a1', 'cable-fly', 3, { label: 'Cable fly', target: target(3, 8, 12) }), slot('a2', 'meadows-row', 3, { label: 'Meadows row', target: target(3, 8, 12) })], { restSeconds: 75 }),
      ],
    },
  ]);
  const lastTime = [
    performance({ date: '2031-12-10', lift: 'cable-fly', label: 'Cable fly', sets: [lb(40, 12), lb(40, 11), lb(40, 10)], target: target(3, 8, 12) }),
    performance({ date: '2031-12-10', lift: 'meadows-row', label: 'Meadows row', sets: [lb(60, 10), lb(60, 9), lb(60, 9)], target: target(3, 8, 12) }),
  ];
  await seed(request, docs(putPrograms(version), putPerformances(...lastTime)));
  await watchForDiary(context);
  await page.clock.install({ time: at(DAY) });
  await openControlled(page);
  await tab(page, 'Train').click();
  await expect(startButton(page)).toBeVisible({ timeout: 15_000 });

  await context.setOffline(true);
  await page.reload();
  await tab(page, 'Train').click();
  await startButton(page).click();

  await expectCard(page, 'Cable fly', 'Round 1 of 3');
  await expect(card(page)).toContainText('8–12 reps. Last, Dec 10: 40 lb × 12/11/10');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('40');
  await expect(page.getByLabel('Reps', { exact: true })).toHaveValue('12');

  // A warm-up does not count as a round, starts no rest and fills no dot.
  await page.getByLabel('Load', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Warm-up', exact: true }).click();
  await logSet(page);
  await expect(toast(page, 'Cable fly logged')).toBeVisible();
  await expectCard(page, 'Cable fly', 'Round 1 of 3');
  await expect(page.getByRole('button', { name: 'Warm-up', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Load', { exact: true }), 'the working weight comes back after a warm-up').toHaveValue('40');
  await expect(page.getByRole('timer')).toBeHidden();
  await expect(planRow(page, /^Cable fly/)).toHaveAccessibleName(/0 of 3 logged/);

  // A1, A2, rest, A1, A2, rest.
  await logExpecting(page, 'Cable fly', 'Round 1 of 3');
  await expect(page.getByRole('timer'), 'no rest inside a round').toBeHidden();
  await logExpecting(page, 'Meadows row', 'Round 1 of 3');
  await expect(page.getByRole('timer')).toHaveText(/^Rest 1:1\d$/);
  await expectCard(page, 'Cable fly', 'Round 2 of 3');
  await expect(planRow(page, /^Cable fly/)).toHaveAccessibleName(/1 of 3 logged/);
  await expect(planRow(page, /^Meadows row/)).toHaveAccessibleName(/1 of 3 logged/);

  await page.clock.fastForward(90_000);
  await expect(page.getByRole('timer'), 'past zero it counts up').toHaveText(/^Rest \+0:1\d$/);

  await tab(page, 'Diary').click();
  await expect(page.getByRole('region', { name: 'Breakfast' })).toBeVisible();
  await tab(page, 'Train').click();
  await expectCard(page, 'Cable fly', 'Round 2 of 3');

  await page.getByLabel('Load', { exact: true }).fill('42.5');
  await page.getByRole('button', { name: 'More reps' }).click();
  await tab(page, 'Diary').click();
  await tab(page, 'Train').click();
  await expect(page.getByLabel('Load', { exact: true }), 'typed digits survive a tab switch').toHaveValue('42.5');
  await expect(page.getByLabel('Reps', { exact: true })).toHaveValue('12');

  await page.reload();
  await expectCard(page, 'Cable fly', 'Round 2 of 3');
  expect(await sawDiary(page), 'a reload during a session never shows the Diary').toBe(false);
  await expect(page.getByLabel('Load', { exact: true }), 'typed digits survive a reload').toHaveValue('42.5');
  await expect(page.getByRole('timer'), 'the rest clock reads right after a reload').toHaveText(/^Rest \+0:\d\d$/);
  await logSet(page);

  await expectCard(page, 'Meadows row', 'Round 2 of 3');
  await page.getByLabel('Load', { exact: true }).fill('62.5');
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto('/');
  await expectCard(reopened, 'Meadows row', 'Round 2 of 3');
  expect(await sawDiary(reopened), 'nor does a relaunch').toBe(false);
  await expect(reopened.getByLabel('Load', { exact: true }), 'typed digits survive the page being killed').toHaveValue('62.5');
  await logSet(reopened);
  await expectCard(reopened, 'Cable fly', 'Round 3 of 3');
  await expect(reopened.getByLabel('Load', { exact: true }), 'the next set takes the load of the last one today').toHaveValue('42.5');
  expect(reachesServer(DAY), 'nothing has reached the server yet').toEqual([]);
  await expect(reopened.getByText(/\d+ waiting/)).toBeVisible();

  await context.setOffline(false);
  await expect(reopened.getByText(/\d+ waiting/)).toBeHidden({ timeout: 20_000 });
  expect(reachesServer(DAY)).toEqual([
    {
      lift: 'cable-fly',
      slot: 'a1',
      planned: undefined,
      sets: [
        { load: { kind: 'weight', amount: 20, unit: 'lb' }, reps: { kind: 'total', reps: 12 }, warmup: true },
        { load: { kind: 'weight', amount: 40, unit: 'lb' }, reps: { kind: 'total', reps: 12 }, warmup: false },
        { load: { kind: 'weight', amount: 42.5, unit: 'lb' }, reps: { kind: 'total', reps: 12 }, warmup: false },
      ],
    },
    {
      lift: 'meadows-row',
      slot: 'a2',
      planned: undefined,
      sets: [
        { load: { kind: 'weight', amount: 60, unit: 'lb' }, reps: { kind: 'total', reps: 10 }, warmup: false },
        { load: { kind: 'weight', amount: 62.5, unit: 'lb' }, reps: { kind: 'total', reps: 9 }, warmup: false },
      ],
    },
  ]);
  const onServer = stored('session').filter((s) => s.date === DAY);
  expect(onServer).toHaveLength(1);
  expect(onServer[0]).toMatchObject({ programId: version.id, day: { key: 'push', label: 'Push day' } });
  expect(onServer[0]?.finishedAt).toBeUndefined();
});

test('a swap mid-superset keeps the order, prefills from the new lift, and both last-times read right next week', async ({ page, request }) => {
  const MONDAY = '2031-11-03';
  const DAY = '2031-11-05';
  const press = slot('a1', 'landmine-press', 3, { label: 'Landmine press', target: target(3, 8, 12) });
  const row = slot('a2', 'cable-row', 3, { label: 'Cable row', target: target(3, 8, 12), swaps: [{ liftId: lift('dumbbell-row'), label: 'Dumbbell row', cue: 'Invented cue for the swap.' }] });
  const version = program(MONDAY, [{ key: 'pair', label: 'Pair day', weekday: 3, blocks: [liftsBlock('pair', [press, row], { restSeconds: 60 })] }]);
  const earlier = '2031-10-29';
  const history = [
    performance({ date: earlier, lift: 'landmine-press', label: 'Landmine press', sets: [lb(50, 10), lb(50, 10), lb(50, 9)] }),
    performance({ date: earlier, lift: 'cable-row', label: 'Cable row', sets: [lb(70, 10), lb(70, 10), lb(70, 10)] }),
    performance({ date: '2031-10-25', lift: 'dumbbell-row', label: 'Dumbbell row', sets: [kg(30, 12), kg(30, 11)] }),
  ];
  await seed(request, docs(putPrograms(version), putPerformances(...history)));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await startButton(page).click();

  // The first slot goes to a name typed on the spot, before any set, and stays there through its rounds.
  await expectCard(page, 'Landmine press', 'Round 1 of 3');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Swap' });
  await expect(sheet.getByRole('list', { name: 'Listed for this slot' })).toHaveCount(0);
  await sheet.getByLabel('Another lift').fill('Zottman press (seated)');
  await sheet.getByRole('button', { name: 'Use "Zottman press (seated)"' }).click();
  await expectCard(page, 'Zottman press (seated)', 'Round 1 of 3');
  await expect(card(page), 'a lift never done has no last line').not.toContainText('Last,');
  await expect(page.getByLabel('Load', { exact: true }), 'and never the old lift’s weight').toHaveValue('');
  await page.reload();
  await expectCard(page, 'Zottman press (seated)', 'Round 1 of 3');
  await page.getByLabel('Load', { exact: true }).fill('35');
  await logSet(page);

  await logExpecting(page, 'Cable row', 'Round 1 of 3');
  await expectCard(page, 'Zottman press (seated)', 'Round 2 of 3');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('35');
  await logSet(page);

  // The second slot swaps mid-superset, from the listed choice.
  await expectCard(page, 'Cable row', 'Round 2 of 3');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('70');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Dumbbell row' }).click();
  await expectCard(page, 'Dumbbell row', 'Round 2 of 3');
  await expect(card(page)).toContainText('Last, Oct 25: 30 kg × 12/11');
  await expect(page.getByLabel('Load', { exact: true }), 'the swapped lift’s own weight').toHaveValue('30');
  await expect(page.getByRole('radio', { name: 'kg' })).toBeChecked();
  await page.getByRole('button', { name: 'Cues', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Cues' }).getByText('Invented cue for the swap.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Cues' }).getByRole('button', { name: 'Done' }).click();
  await logSet(page);

  await logExpecting(page, 'Zottman press (seated)', 'Round 3 of 3');
  await expectCard(page, 'Dumbbell row', 'Round 3 of 3');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('30');
  await logSet(page);
  await finishButton(page).click();
  await expect(toast(page, /^Finished Pair day/)).toBeVisible();

  await expect
    .poll(() => reachesServer(DAY).map((p) => [p.lift, p.slot, p.planned, p.sets.length]))
    .toEqual([
      ['cable-row', 'a2', undefined, 1],
      ['dumbbell-row', 'a2', 'cable-row', 2],
      ['zottman-press', 'a1', 'landmine-press', 3],
    ]);

  // Next week, the first slot was swapped for the whole of last time, and the second only in part.
  await page.clock.fastForward(7 * 24 * 60 * MINUTE);
  await tab(page, 'Diary').click();
  await tab(page, 'Train').click();
  await startButton(page).click();
  await expectCard(page, 'Landmine press', 'Round 1 of 3');
  await expect(card(page)).toContainText('Last, Oct 29: 50 lb × 10/10/9');
  await expect(card(page)).toContainText('Last time here you did Zottman press (seated).');
  await page.getByRole('button', { name: 'Switch' }).click();
  await expectCard(page, 'Zottman press (seated)', 'Round 1 of 3');
  await expect(card(page)).toContainText('Last, Nov 5: 35 lb × 8/8/8');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('35');
  await logSet(page);

  await expectCard(page, 'Cable row', 'Round 1 of 3');
  await expect(card(page)).toContainText('Last, Nov 5: 70 lb × 10');
  await expect(card(page), 'he did the planned lift that day too').not.toContainText('Last time here');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Dumbbell row' }).click();
  await expect(card(page)).toContainText('Last, Nov 5: 30 kg × 12/11');
});

test('kg and lb in one lift, bodyweight, a band, per-side, an extra set, a skip, a 2-set slot, a checklist, cardio, an edit and a delete', async ({ page, request }) => {
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
        cardio('bike', { title: 'Easy bike' }),
        liftsBlock('extra', [slot('f1', 'dead-bug', 2, { label: 'Dead bug', target: target(2, 10, 10, { load: 'bodyweight' }) })], { title: 'Extras', optional: true }),
      ],
    },
  ]);
  await seed(request, docs(putPrograms(version), [{ op: 'put', kind: 'weighIn', doc: { id: `w:${DAY}`, date: day(DAY), kg: 80, loggedAt: ms(at(DAY, '07:00:00').getTime()) } }]));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await startButton(page).click();

  // A checklist is one Done, with an undo.
  const checklistCard = page.getByRole('region', { name: 'Checklist' });
  await expect(checklistCard.getByText('Band pull-apart')).toBeVisible();
  await checklistCard.getByRole('button', { name: 'Done' }).click();
  await expectCard(page, 'Goblet squat', 'Round 1 of 3');
  await expect(planRow(page, /^Warm up/)).toHaveAccessibleName(/1 of 1 logged/);
  await toast(page, 'Warm up done').getByRole('button', { name: 'Undo' }).click();
  await expect(checklistCard).toBeVisible();
  await checklistCard.getByRole('button', { name: 'Done' }).click();

  // Log set stays off until a load is typed. The steppers go by 2.5 lb, then 1 kg once he switches.
  await expectCard(page, 'Goblet squat', 'Round 1 of 3');
  await expect(logButton(page)).toBeDisabled();
  await expect(page.getByLabel('Reps', { exact: true }), 'reps start at the bottom of the range').toHaveValue('8');
  await page.getByLabel('Load', { exact: true }).fill('50');
  await page.getByRole('button', { name: 'More load' }).click();
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('52.5');
  await page.getByRole('button', { name: 'Less load' }).click();
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('50');
  await logSet(page);

  // A per-side set shows two rows in the order the target names.
  await expectCard(page, 'Pallof press', 'Round 1 of 3');
  await expect(page.locator('.set-row-unit.side')).toHaveText(['R', 'L']);
  await page.getByLabel('Load', { exact: true }).fill('25');
  await expect(page.getByLabel('Left reps', { exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: 'Less left reps' }).click();
  await logSet(page);

  // kg in the same lift, inherited by the next set, with the number staying as typed.
  await expectCard(page, 'Goblet squat', 'Round 2 of 3');
  await page.getByRole('radio', { name: 'kg' }).click();
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('50');
  await page.getByLabel('Load', { exact: true }).fill('22');
  await page.getByRole('button', { name: 'More load' }).click();
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('23');
  await logSet(page);
  await logExpecting(page, 'Pallof press', 'Round 2 of 3');

  // The 2-set slot drops out of the third round, and the round still rests.
  await expectCard(page, 'Goblet squat', 'Round 3 of 3');
  await expect(page.getByLabel('Load', { exact: true })).toHaveValue('23');
  await expect(page.getByRole('radio', { name: 'kg' })).toBeChecked();
  await logSet(page);
  await expect(page.getByRole('timer')).toHaveText(/^Rest (1:00|0:5\d)$/);

  // A band load is a label.
  await expectCard(page, 'Band row', 'Round 1 of 2');
  await expect(page.getByLabel('Load', { exact: true })).toHaveCount(0);
  await expect(logButton(page)).toBeDisabled();
  await page.getByLabel('Band', { exact: true }).fill('green');
  await logSet(page);
  await expectCard(page, 'Band row', 'Round 2 of 2');
  await expect(page.getByLabel('Band', { exact: true })).toHaveValue('green');
  await logSet(page);

  // A bodyweight load hides the load row, with a way to add weight.
  await expectCard(page, 'Chin-up', 'Round 1 of 2');
  await expect(page.getByLabel('Load', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Bodyweight', { exact: true })).toBeVisible();
  await logSet(page);
  await expectCard(page, 'Chin-up', 'Round 2 of 2');
  await page.getByRole('button', { name: 'Add weight' }).click();
  await page.getByLabel('Load', { exact: true }).fill('10');
  await logSet(page);

  // A tap on any slot jumps the card, and past the prescription it is an extra set.
  await expectCard(page, 'Sled push', 'Round 1 of 1');
  await planRow(page, /^Chin-up/).click();
  await expectCard(page, 'Chin-up', 'Extra set');
  await expect(page.getByLabel('Load', { exact: true }), 'an extra set takes the last load').toHaveValue('10');
  await logSet(page);
  await expect(planRow(page, /^Chin-up/)).toHaveAccessibleName(/3 of 3 logged/);

  // The card goes back to where the data says, and a set prompt lands on the set.
  await expectCard(page, 'Sled push', 'Round 1 of 1');
  await page.getByLabel('Load', { exact: true }).fill('90');
  await page.getByLabel('Distance').fill('Forty metres');
  await logSet(page);

  // A skip moves on, undoes, and holds its note.
  await expectCard(page, 'Suitcase carry', 'Round 1 of 1');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('dialog', { name: 'Skip Suitcase carry' }).getByRole('button', { name: 'Skip it' }).click();
  const bikeCard = page.getByRole('region', { name: 'Cardio' });
  await expect(bikeCard).toBeVisible();
  await expect(planRow(page, /^Suitcase carry/)).toContainText('Skipped');
  await toast(page, 'Skipped Suitcase carry').getByRole('button', { name: 'Undo' }).click();
  await expectCard(page, 'Suitcase carry', 'Round 1 of 1');
  await expect(planRow(page, /^Suitcase carry/)).not.toContainText('Skipped');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const skip = page.getByRole('dialog', { name: 'Skip Suitcase carry' });
  await skip.getByLabel('Why, if you want to say').fill('Invented reason for skipping.');
  await skip.getByRole('button', { name: 'Skip it' }).click();

  // Cardio opens the existing logger, and that workout satisfies the block.
  await expect(bikeCard).toBeVisible();
  await bikeCard.getByRole('button', { name: 'Log cardio' }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await logger.getByRole('button', { name: /^Stationary bike/ }).click();
  await logger.getByRole('button', { name: '15 min' }).click();
  await logger.getByRole('button', { name: 'Log workout' }).click();
  const doneCard = page.getByRole('region', { name: 'Done' });
  await expect(doneCard).toContainText('That is the plan done');
  await expect(planRow(page, /^Easy bike/)).toHaveAccessibleName(/1 of 1 logged/);

  // An optional block is reached by a tap, and keeps him until its gaps are filled.
  await planRow(page, /^Dead bug/).click();
  await logExpecting(page, 'Dead bug', 'Round 1 of 2');
  await logExpecting(page, 'Dead bug', 'Round 2 of 2');
  await expect(doneCard).toBeVisible();

  // Editing a set from its row in the plan, with an undo.
  await plan(page).getByRole('button', { name: '50 lb × 8' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Goblet squat' });
  await edit.getByLabel('Load', { exact: true }).fill('55');
  await edit.getByLabel('Reps', { exact: true }).fill('9');
  await edit.getByRole('button', { name: 'Save set' }).click();
  await expect(plan(page).getByRole('button', { name: '55 lb × 9' })).toBeVisible();
  await toast(page, 'Set updated').getByRole('button', { name: 'Undo' }).click();
  await expect(plan(page).getByRole('button', { name: '50 lb × 8' })).toBeVisible();

  // Deleting one, with an undo. Deleting the last of a slot takes its dots and sends the card back.
  await plan(page).getByRole('button', { name: /Forty metres/ }).click();
  await page.getByRole('dialog', { name: 'Edit Sled push' }).getByRole('button', { name: 'Delete set' }).click();
  await expectCard(page, 'Sled push', 'Round 1 of 1');
  await expect(planRow(page, /^Sled push/)).toHaveAccessibleName(/0 of 1 logged/);
  await toast(page, 'Set deleted').getByRole('button', { name: 'Undo' }).click();
  await expect(doneCard).toBeVisible();

  // Notes on the exercise and on the session.
  await planRow(page, /^Goblet squat/).click();
  await expectCard(page, 'Goblet squat', 'Extra set');
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await note.getByLabel('On Goblet squat').fill('Invented note on the squat.');
  await note.getByRole('button', { name: 'Save note' }).click();
  await expect(toast(page, 'Note saved')).toBeVisible();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('dialog', { name: 'Note' }).getByRole('radio', { name: 'The session' }).click();
  await page.getByRole('dialog', { name: 'Note' }).getByLabel('On the session').fill('Invented note on the session.');
  await page.getByRole('dialog', { name: 'Note' }).getByRole('button', { name: 'Save note' }).click();
  await expect(toast(page, 'Note saved')).toBeVisible();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();

  await expect(page.getByTestId('week-count')).toHaveText('1 of 1 done');
  await expect(page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Mixed day/ })).toContainText('Done Wed');

  await expect.poll(() => stored('session').filter((s) => s.date === DAY && s.finishedAt !== undefined).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(6);
  const held = new Map(stored('performance').filter((p) => p.date === DAY).map((p) => [p.liftId, p]));
  const units = held.get(lift('goblet-squat'))?.sets.map((set) => (set.load.kind === 'weight' ? `${set.load.amount} ${set.load.unit}` : null));
  expect(units, 'lb and kg in one lift, each as typed').toEqual(['50 lb', '23 kg', '23 kg']);
  expect(held.get(lift('goblet-squat'))?.note).toBe('Invented note on the squat.');
  expect(held.get(lift('pallof-press'))?.sets[0]?.reps).toEqual({ kind: 'sides', left: 9, right: 10 });
  expect(held.get(lift('band-row'))?.sets.map((set) => set.load)).toEqual([{ kind: 'band', label: 'green' }, { kind: 'band', label: 'green' }]);
  expect(held.get(lift('chin-up'))?.sets.map((set) => set.load)).toEqual([{ kind: 'bodyweight' }, { kind: 'weight', amount: 10, unit: 'lb' }, { kind: 'weight', amount: 10, unit: 'lb' }]);
  expect(held.get(lift('sled-push'))?.sets[0]?.note).toBe('Forty metres');
  const finished = stored('session').find((s) => s.date === DAY);
  expect(finished?.skips).toEqual([{ slotId: 'e1', note: 'Invented reason for skipping.' }]);
  expect(finished?.checked).toEqual(['warm']);
  expect(finished?.note).toBe('Invented note on the session.');
});

test('a version published mid-session changes nothing on the card, and a new session uses it', async ({ page, request }) => {
  const MONDAY = '2031-10-06';
  const DAY = '2031-10-08';
  const slots = [slot('a1', 'trap-bar-deadlift', 3, { label: 'Trap bar deadlift', target: target(3, 8, 12) })];
  const older = program(MONDAY, [{ key: 'pull', label: 'Pull day', weekday: 3, blocks: [liftsBlock('main', slots, { restSeconds: 90 })] }]);
  const newer = program(DAY, [{ key: 'pull', label: 'Pull day, new', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'trap-bar-deadlift', 5, { label: 'Deadlift, rewritten', target: target(5, 3, 5) })], { restSeconds: 180 })] }]);
  await seed(request, putPrograms(older));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await startButton(page).click();
  await expectCard(page, 'Trap bar deadlift', 'Round 1 of 3');
  await page.getByLabel('Load', { exact: true }).fill('225');
  await logSet(page);

  await seed(request, putPrograms(newer));
  const before = await countOnPhone(page, 'program');
  await expectCard(page, 'Trap bar deadlift', 'Round 2 of 3');
  await logSet(page);
  await expect.poll(() => countOnPhone(page, 'program'), { timeout: 15_000 }).toBe(before + 1);

  await expectCard(page, 'Trap bar deadlift', 'Round 3 of 3');
  await expect(card(page)).toContainText('8–12 reps.');
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(plan(page)).toContainText('Rest 90s');
  await expect(page.getByRole('heading', { name: 'Pull day', exact: true })).toBeVisible();
  await page.reload();
  await expectCard(page, 'Trap bar deadlift', 'Round 3 of 3');
  await expect(page.getByRole('heading', { name: 'Pull day', exact: true })).toBeVisible();

  await finishButton(page).click();
  await expect(page.getByTestId('week-count')).toBeVisible();
  await page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Pull day, new/ }).first().click();
  await page.getByRole('dialog', { name: 'Pull day, new' }).getByRole('button', { name: 'Start', exact: true }).click();
  await expectCard(page, 'Deadlift, rewritten', 'Round 1 of 5');
  await expect(card(page)).toContainText('3–5 reps.');
  await page.getByLabel('Load', { exact: true }).fill('225');
  await logSet(page);

  await expect.poll(() => stored('session').filter((s) => s.date === DAY).length, { timeout: 15_000 }).toBe(2);
  expect(
    stored('session')
      .filter((s) => s.date === DAY)
      .map((s) => s.programId)
      .toSorted(),
  ).toEqual([older.id, newer.id].toSorted());
});

for (const policy of ['activity-level', 'eat-back-workouts'] as const) {
  test(`under ${policy}, finishing twice leaves one workout and lifting and cardio do not overlap`, async ({ page, request }) => {
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
    const weighIn: Mutation = { op: 'put', kind: 'weighIn', doc: { id: `w:${DAY}`, date: DAY, kg: 80, loggedAt: ms(at(DAY, '07:00:00').getTime()) } };
    const profile: Mutation = { op: 'put', kind: 'profile', doc: { id: PROFILE_ID, sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 } };
    await seed(request, docs(putPrograms(version), [profile, goal, weighIn]));
    await page.clock.install({ time: at(DAY) });
    await page.goto('/');
    await expect(page.getByTestId('kcal-target')).toBeVisible({ timeout: 15_000 });
    const baseTarget = await page.getByTestId('kcal-target').textContent();

    await tab(page, 'Train').click();
    await startButton(page).click();
    await expectCard(page, 'Front squat', 'Round 1 of 2');
    await page.getByLabel('Load', { exact: true }).fill('135');
    await logSet(page);
    await logExpecting(page, 'Front squat', 'Round 2 of 2');
    await page.clock.fastForward(30 * MINUTE);

    await page.getByRole('region', { name: 'Cardio' }).getByRole('button', { name: 'Log cardio' }).click();
    const logger = page.getByRole('dialog', { name: 'Add workout' });
    await logger.getByRole('button', { name: /^Walking, 3 mph.*MET/ }).click();
    await logger.getByLabel('Duration').fill('20');
    await logger.getByRole('button', { name: 'Log workout' }).click();
    await expect(page.getByRole('region', { name: 'Done' })).toBeVisible();
    await page.clock.fastForward(30 * MINUTE);

    await finishButton(page).dblclick();
    await expect(toast(page, /^Finished Lift and ride, 40 min in the diary/)).toBeVisible();
    await toast(page, /^Finished Lift and ride/).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('region', { name: 'Done' }), 'undo reopens the session').toBeVisible();
    await finishButton(page).click();

    await expect(page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Lift and ride/ })).toContainText('Done Wed');
    await tab(page, 'Diary').click();
    const workouts = page.getByRole('region', { name: 'Workouts' });
    await expect(workouts.getByRole('button', { name: /^Lift and ride/ })).toContainText('40 min');
    await expect(workouts.getByRole('button', { name: /^Walking, 3 mph/ })).toContainText('20 min');
    await expect(workouts.getByRole('listitem'), 'two workouts and the add row').toHaveCount(3);

    await expect.poll(() => stored('workout').filter((w) => w.date === DAY).length, { timeout: 15_000 }).toBe(2);
    const finished = stored('session').find((s) => s.date === DAY);
    expect(finished?.finishedAt).toBeDefined();
    const lifted = stored('workout').filter((w) => finished !== undefined && w.id === sessionWorkoutId(finished));
    const walked = stored('workout').filter((w) => w.date === DAY && finished !== undefined && w.id !== sessionWorkoutId(finished));
    expect(lifted.map((w) => [w.name, w.minutes])).toEqual([['Lift and ride', 40]]);
    expect(walked.map((w) => w.minutes)).toEqual([20]);
    // 2.5 MET above resting for 40 minutes, and 2.8 for 20, at the trend weight the day holds.
    const kcalOf = (met: number, minutes: number, kg: number) => Math.round((met * kg * minutes) / 60);
    const liftedKcal = lifted.map((w) => w.kcal)[0];
    const walkedKcal = walked.map((w) => w.kcal)[0];
    expect(liftedKcal).toBe(kcalOf(2.5, 40, lifted[0]?.kg ?? 0));
    expect(walkedKcal).toBe(kcalOf(2.8, 20, walked[0]?.kg ?? 0));
    if (policy === 'activity-level') {
      await expect(page.getByTestId('kcal-workouts'), 'the budget does not move').toHaveCount(0);
      await expect(page.getByText('Not added to your target.')).toBeVisible();
    } else {
      await expect(page.getByTestId('kcal-workouts'), 'lifting and cardio, each once').toHaveText(String((liftedKcal ?? 0) + (walkedKcal ?? 0)));
    }
    expect(await page.getByTestId('kcal-target').textContent(), 'the goal itself never moves').toBe(baseTarget);
  });
}

test('a forgotten session is settled at its last set on the next launch, and a session with nothing in it is dropped', async ({ page, context, request }) => {
  const MONDAY = '2031-09-08';
  const DAY = '2031-09-10';
  const version = program(MONDAY, [{ key: 'solo', label: 'Solo day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })], { restSeconds: 90 })] }]);
  const weighIn: Mutation = { op: 'put', kind: 'weighIn', doc: { id: `w:${DAY}`, date: day(DAY), kg: 80, loggedAt: ms(at(DAY, '07:00:00').getTime()) } };
  await seed(request, docs(putPrograms(version), [weighIn]));
  await stubWakeLock(context, 'grant');
  await page.clock.install({ time: at(DAY, '09:00:00') });
  await openWeek(page);
  expect(await wakeLockLog(page), 'no lock with no session').toEqual([]);

  // A mistaken Start undoes from its toast.
  await startButton(page).click();
  await expectCard(page, 'Seal row', 'Round 1 of 3');
  await toast(page, 'Started Solo day').getByRole('button', { name: 'Undo' }).click();
  await expect(startButton(page)).toBeVisible();

  // Or Finish leaves no trace of it, and that undo brings the session back.
  await startButton(page).click();
  await expectCard(page, 'Seal row', 'Round 1 of 3');
  await finishButton(page).click();
  await expect(toast(page, 'Nothing logged, so it does not count')).toBeVisible();
  await expect(page.getByTestId('week-count')).toHaveText('0 of 1 done');
  await expect.poll(async () => JSON.stringify(await wakeLockLog(page)), 'a session asks to keep the screen on, and lets go when it ends').toMatch(/^\["request","release",.*"request","release"\]$/);
  await toast(page, 'Nothing logged, so it does not count').getByRole('button', { name: 'Undo' }).click();
  await expectCard(page, 'Seal row', 'Round 1 of 3');

  await page.getByLabel('Load', { exact: true }).fill('70');
  await logButton(page).dblclick();
  await expectCard(page, 'Seal row', 'Round 2 of 3');
  await expect(planRow(page, /^Seal row/), 'a double tap logs one set').toHaveAccessibleName(/1 of 3 logged/);
  await page.clock.fastForward(10 * MINUTE);
  await logSet(page);
  await expectCard(page, 'Seal row', 'Round 3 of 3');
  await page.clock.fastForward(5 * 60 * MINUTE);
  await page.reload();
  await expectCard(page, 'Seal row', 'Round 3 of 3');

  await page.clock.fastForward(61 * MINUTE);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Breakfast' }), 'no longer open, so it starts on the Diary').toBeVisible();
  await expect(toast(page, /^Finished Solo day at its last set/)).toBeVisible();
  const workouts = page.getByRole('region', { name: 'Workouts' });
  await expect(workouts.getByRole('button', { name: /^Solo day/ })).toContainText('10 min');

  await tab(page, 'Train').click();
  await expect(page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Solo day/ })).toContainText('Done Wed');
  await expect.poll(() => stored('workout').filter((w) => w.date === DAY).map((w) => w.minutes), { timeout: 15_000 }).toEqual([10]);
  const settled = stored('session').find((s) => s.date === DAY);
  const tapped = stored('performance').find((p) => p.date === DAY)?.sets.at(-1)?.at;
  expect(settled?.finishedAt, 'at the last set’s time').toBe(tapped);
});

test('midnight keeps the session’s date, and a refused wake lock changes nothing', async ({ page, context, request }) => {
  const MONDAY = '2031-08-11';
  const DAY = '2031-08-13';
  const version = program(MONDAY, [{ key: 'late', label: 'Late day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pendlay-row', 2, { label: 'Pendlay row', target: target(2, 8, 12) })], { restSeconds: 60 })] }]);
  await seed(request, putPrograms(version));
  const trouble: string[] = [];
  page.on('pageerror', (err) => trouble.push(err.message));
  await stubWakeLock(context, 'refuse');
  await page.clock.install({ time: at(DAY, '23:50:00') });
  await openWeek(page);
  await startButton(page).click();
  await expectCard(page, 'Pendlay row', 'Round 1 of 2');
  await page.getByLabel('Load', { exact: true }).fill('95');
  await logSet(page);

  await page.clock.fastForward(20 * MINUTE);
  await expectCard(page, 'Pendlay row', 'Round 2 of 2');
  await logSet(page);
  await expect.poll(() => reachesServer(DAY).map((p) => p.sets.length), { timeout: 15_000 }).toEqual([2]);
  expect(stored('session').find((s) => s.date === DAY)?.date, 'the date it started').toBe(DAY);
  expect(await wakeLockLog(page)).toContain('request');
  expect(trouble).toEqual([]);
});

test('says so when this phone does not hold the version a session pinned, and still finishes', async ({ page, request }) => {
  const MONDAY = '2031-08-04';
  const DAY = '2031-08-06';
  const unheld = program('2031-08-01', [{ key: 'gone', blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3)])] }]);
  const open: Mutation = { op: 'put', kind: 'session', doc: { ...session({ date: day(DAY), day: { key: dayKey('gone'), label: 'Gone day' }, startedAt: ms(at(DAY).getTime()) }), programId: unheld.id } };
  await seed(request, docs(putPrograms(program(MONDAY, [{ key: 'now', label: 'Now day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3)])] }])), [open]));
  await page.clock.install({ time: at(DAY) });
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(page.getByText('This session\'s plan is not on this phone yet.')).toBeVisible({ timeout: 15_000 });
  await finishButton(page).click();
  await expect(toast(page, 'Nothing logged, so it does not count')).toBeVisible();
  await expect(startButton(page)).toBeVisible();
});

test('Tell the coach writes a loose note from the Coach sheet, with an undo', async ({ page, request }) => {
  const MONDAY = '2031-07-14';
  const DAY = '2031-07-16';
  const version = program(MONDAY, [{ key: 'one', label: 'One day', weekday: 3, blocks: [liftsBlock('main', [slot('a1', 'pin-press', 3, { label: 'Pin press' })])] }]);
  await seed(request, putPrograms(version));
  await page.clock.install({ time: at(DAY) });
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(page.getByTestId('week-count')).toBeVisible({ timeout: 15_000 });
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

test('a copy of the pinned version replaced under an open session moves the card, and the sets already logged stay stored', async ({ page, request }) => {
  const MONDAY = '2031-06-30';
  const DAY = '2031-07-02';
  const trouble: string[] = [];
  page.on('pageerror', (err) => trouble.push(err.message));
  const first = program(MONDAY, [{ key: 'moved', label: 'Moved day', weekday: 3, blocks: [liftsBlock('pair', [slot('a1', 'seal-row', 2, { label: 'Seal row', target: target(2, 8, 12) }), slot('a2', 'pendlay-row', 2, { label: 'Pendlay row', target: target(2, 8, 12) })])] }]);
  const replaced = program(MONDAY, [{ key: 'moved', label: 'Moved day', weekday: 3, blocks: [liftsBlock('main', [slot('b1', 'pin-press', 2, { label: 'Pin press', target: target(2, 5, 5) })])] }]);
  await seed(request, putPrograms(first));
  await page.clock.install({ time: at(DAY) });
  await openWeek(page);
  await startButton(page).click();
  await expectCard(page, 'Seal row', 'Round 1 of 2');
  await page.getByLabel('Load', { exact: true }).fill('70');
  await logSet(page);
  await expectCard(page, 'Pendlay row', 'Round 1 of 2');
  await page.getByLabel('Load', { exact: true }).fill('95');
  await logSet(page);
  await expectCard(page, 'Seal row', 'Round 2 of 2');
  await expect.poll(() => reachesServer(DAY).length, { timeout: 15_000 }).toBe(2);

  await seed(request, putPrograms(replaced));
  await page.reload();
  await expectCard(page, 'Pin press', 'Round 1 of 2');
  await expect(plan(page)).not.toContainText('Seal row');
  await page.getByLabel('Load', { exact: true }).fill('135');
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
