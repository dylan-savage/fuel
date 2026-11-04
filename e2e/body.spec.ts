/**
 * Phase 5 on a production build: weigh-ins over several days build a trend and a goal
 * projection, a workout logged offline reaches fuel.db, and eating back workouts raises
 * the day's remaining calories by the workout's burn.
 */
import { expect, test, type Page } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { weighInId } from '../src/domain/body.js';
import { KG_PER_LB } from '../src/domain/goals.js';
import { Millis, addDays } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import { kcalOf, openControlled, openRow, saveGoal, seed, setGoal, stored, tab } from './app.js';

const shown = (n: number) => Math.round(Math.abs(n)).toLocaleString('en-US');

const openWeight = async (page: Page) => {
  await page.getByRole('button', { name: /^Weight/ }).click();
  return page.getByRole('dialog', { name: 'Weight' });
};

async function weighIn(page: Page, daysAgo: number, pounds: string) {
  const weight = await openWeight(page);
  await weight.getByRole('button', { name: 'Weigh in', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Weigh-in' });
  await sheet.getByLabel('Date').fill(addDays(localDate(), -daysAgo));
  await sheet.getByLabel('Weight').fill(pounds);
  await sheet.getByRole('button', { name: 'Save weigh-in' }).click();
  await expect(sheet).toBeHidden();
  await weight.getByRole('button', { name: 'Done' }).click();
}

/** Clears the workouts other specs left, so today's burn is only what this spec logs. */
function clearWorkouts(): Mutation[] {
  return stored('workout').map((w): Mutation => ({ op: 'delete', kind: 'workout', id: w.id }));
}

test('logs weigh-ins over several days and sees the trend, rate and projected goal date', async ({ page }) => {
  await page.goto('/');
  await setGoal(page);
  await openRow(page, 'Weekly goal');
  await page.getByLabel('Goal weight').fill('170');
  await saveGoal(page);
  await tab(page, 'Diary').click();

  // 183.0, 182.8, 182.6 lb: the trend moves a tenth of the way each day, 183 → 182.98 → 182.942.
  for (const [daysAgo, pounds] of [
    [13, '183.0'],
    [12, '182.8'],
    [11, '182.6'],
  ] as const) {
    await weighIn(page, daysAgo, pounds);
  }
  const sheet = await openWeight(page);
  await expect(sheet.getByTestId('trend-weight')).toHaveText('182.9 lb');
  await expect(sheet.getByTestId('weekly-rate')).toHaveText('No rate yet');
  await expect(sheet.getByTestId('projection')).toHaveText('Not enough data');
  await sheet.getByRole('button', { name: 'Done' }).click();

  for (let daysAgo = 10; daysAgo >= 0; daysAgo--) await weighIn(page, daysAgo, (183 - 0.2 * (13 - daysAgo)).toFixed(1));
  await openWeight(page);
  await expect(sheet.getByTestId('weekly-rate')).toHaveText(/^−\d\.\d lb a week$/);
  await expect(sheet.getByTestId('projection')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  await expect(sheet.getByRole('figure', { name: 'Weight over 30 days' })).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'Weigh-ins' }).getByRole('listitem')).toHaveCount(14);
  await expect.poll(() => stored('weighIn').length, { timeout: 15_000 }).toBe(14);
  await sheet.getByRole('button', { name: 'Done' }).click();

  // From a past day, picking a later day still finds its reading, and a day with none starts blank.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await (await openWeight(page)).getByRole('button', { name: 'Weigh in', exact: true }).click();
  const entry = page.getByRole('dialog', { name: 'Weigh-in' });
  await expect(entry.getByLabel('Date')).toHaveValue(addDays(localDate(), -1));
  await entry.getByLabel('Date').fill(localDate());
  await expect(entry.getByLabel('Weight')).toHaveValue((183 - 0.2 * 13).toFixed(1));
  await expect(entry.getByRole('button', { name: 'Delete weigh-in' })).toBeVisible();
  await entry.getByLabel('Date').fill(addDays(localDate(), -20));
  await expect(entry.getByLabel('Weight')).toHaveValue('');
  await expect(entry.getByRole('button', { name: 'Delete weigh-in' })).toBeHidden();
});

test('logs a workout offline and still shows it after reconnecting', async ({ page, context, request }) => {
  const today = localDate();
  const weight: Mutation = { op: 'put', kind: 'weighIn', doc: { id: weighInId(today), date: today, kg: 180 * KG_PER_LB, loggedAt: Millis.parse(Date.now()) } };
  await seed(request, [...clearWorkouts(), weight]);
  await openControlled(page);
  // The burn needs a body weight, so the weigh-in must be on the phone before the network goes.
  await expect(page.getByTestId('day-trend')).toBeVisible();
  await context.setOffline(true);
  await page.reload();

  const workouts = page.getByRole('region', { name: 'Workouts' });
  await workouts.getByRole('button', { name: 'Add workout' }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await logger.getByRole('region', { name: 'Running' }).getByRole('button', { name: /^Running, 6 mph/ }).click();
  await logger.getByRole('button', { name: '45 min', exact: true }).click();
  const burn = await kcalOf(page, 'workout-kcal');
  expect(burn).toBeGreaterThan(0);
  await logger.getByRole('button', { name: 'Log workout' }).click();

  await expect(workouts.getByRole('button', { name: /^Running, 6 mph/ })).toContainText(shown(burn));
  await expect(page.getByText('1 waiting')).toBeVisible();
  expect(stored('workout')).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  const [synced, ...others] = stored('workout');
  expect(others).toEqual([]);
  // (9.3 − 1) MET × kg × 0.75 h, at the weight it was logged at.
  expect(synced?.kcal).toBe(Math.round(8.3 * (synced?.kg ?? 0) * 0.75));
  expect(synced?.kcal).toBe(burn);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Workouts' }).getByRole('button', { name: /^Running, 6 mph/ })).toContainText(shown(burn));
});

test('eats back a workout and sees remaining calories rise by its burn', async ({ page, request }) => {
  await seed(request, clearWorkouts());
  await page.goto('/');
  await setGoal(page);
  // Sedentary is the eat-back baseline too, so switching policy changes only the workout part.
  await openRow(page, 'Activity');
  await page.getByRole('radio', { name: /^Sedentary/ }).click();
  await saveGoal(page);

  await tab(page, 'Diary').click();
  const target = await kcalOf(page, 'kcal-target');
  const workouts = page.getByRole('region', { name: 'Workouts' });
  await workouts.getByRole('button', { name: 'Add workout' }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await logger.getByRole('region', { name: 'Gym' }).getByRole('button', { name: /^Strength training(?!,)/ }).click();
  await logger.getByRole('button', { name: '60 min', exact: true }).click();
  const burn = await kcalOf(page, 'workout-kcal');
  await logger.getByRole('button', { name: 'Log workout' }).click();
  await expect(workouts).toContainText(`${shown(burn)} kcal`);
  // Under an activity level a logged workout is recorded and the target stays where it was.
  await expect(page.getByTestId('kcal-target')).toHaveText(shown(target));

  const eaten = await kcalOf(page, 'kcal-eaten');
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target - eaten));

  await tab(page, 'Goal').click();
  await page.getByRole('switch', { name: /^Count workouts/ }).check();
  await expect(page.getByTestId('policy-sentence')).toHaveText(/adds 100% of its calories to that day/);
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Goal saved' })).toBeVisible();

  await tab(page, 'Diary').click();
  await expect(page.getByTestId('kcal-target')).toHaveText(shown(target + burn));
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target + burn - eaten));
});

test('Save appears only once something has changed, and a collapsed row keeps its edit', async ({ page }) => {
  await page.goto('/');
  await setGoal(page);
  const save = page.getByRole('button', { name: 'Save goal' });
  await expect(save).toBeHidden();

  await openRow(page, 'Water');
  const water = page.getByLabel('Daily goal');
  const saved = await water.inputValue();
  await water.fill('96');
  await expect(save).toBeEnabled();
  await page.locator('summary', { hasText: /^Water/ }).click();
  await expect(water).toBeHidden();
  await expect(page.locator('summary', { hasText: /^Water/ })).toContainText('96 fl oz');
  await expect(save, 'still there with its row shut').toBeEnabled();
  await openRow(page, 'Water');
  await expect(water).toHaveValue('96');

  await water.fill(`${saved}.0`);
  await expect(save, 'the same number typed another way is not a change').toBeHidden();

  await water.fill('0');
  await expect(save, 'a change that cannot be saved').toBeDisabled();
  await page.locator('summary', { hasText: /^Water/ }).click();
  await expect(page.locator('summary', { hasText: /^Water/ }), 'and its shut row says so').toContainText('Fix');

  await openRow(page, 'Water');
  await water.fill('96');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Goal saved' })).toBeVisible();
  await expect(save, 'saved, so nothing is left to save').toBeHidden();
  await expect.poll(() => stored('goal').at(-1)?.waterMl, { timeout: 15_000 }).toBeCloseTo(96 * 29.5735, 0);
});

test('a custom target, macros in grams, a goal weight and the share of workouts counted all save', async ({ page }) => {
  await page.goto('/');
  await setGoal(page);

  await openRow(page, 'Weekly goal');
  await page.getByRole('switch', { name: 'Custom calorie target' }).check();
  await page.getByLabel(/^Target/).fill('2100');
  await page.getByLabel('Goal weight').fill('165');
  await expect(page.getByTestId('goal-kcal')).toHaveText('2,100');

  await openRow(page, 'Macros');
  await page.getByRole('radio', { name: 'Grams' }).click();
  await page.getByLabel('Protein').fill('180');
  await page.getByLabel('Carbs').fill('200');
  await page.getByLabel('Fat').fill('70');

  await page.getByRole('switch', { name: /^Count workouts/ }).check();
  await page.getByLabel('Workouts counted').fill('50');
  await expect(page.getByTestId('policy-sentence')).toHaveText(/adds 50%/);
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Goal saved' })).toBeVisible();

  await expect.poll(() => stored('goal').at(-1)?.kcalOverride, { timeout: 15_000 }).toBe(2100);
  const goal = stored('goal').at(-1);
  expect(goal?.macros).toMatchObject({ kind: 'grams', protein: 180, carbs: 200, fat: 70 });
  expect(goal?.policy).toEqual({ kind: 'eat-back-workouts', fraction: 0.5 });
  expect(goal?.goalWeightKg).toBeCloseTo(165 * KG_PER_LB, 3);

  await page.getByText('How this is worked out').click();
  await expect(page.getByText(/^Custom target, plus workouts each day/)).toBeVisible();

  // Back to the plain goal setGoal assumes, for the specs after this one.
  await page.getByRole('switch', { name: 'Custom calorie target' }).uncheck();
  await page.getByRole('switch', { name: /^Count workouts/ }).uncheck();
  await page.getByRole('radio', { name: 'Percent' }).click();
  for (const [label, value] of [
    ['Protein', '30'],
    ['Carbs', '40'],
    ['Fat', '30'],
  ] as const) {
    await page.getByLabel(label).fill(value);
  }
  await saveGoal(page);
});
