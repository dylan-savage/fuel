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
import { kcalOf, openControlled, seed, setGoal, stored, tab } from './app.js';

const shown = (n: number) => Math.round(Math.abs(n)).toLocaleString('en-US');

async function weighIn(page: Page, daysAgo: number, pounds: string) {
  await page.getByRole('region', { name: 'Weight' }).getByRole('button', { name: 'Weigh in', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Weigh-in' });
  await sheet.getByLabel('Date').fill(addDays(localDate(), -daysAgo));
  await sheet.getByLabel('Weight').fill(pounds);
  await sheet.getByRole('button', { name: 'Save weigh-in' }).click();
  await expect(sheet).toBeHidden();
}

/** Clears the workouts other specs left, so today's burn is only what this spec logs. */
function clearWorkouts(): Mutation[] {
  return stored('workout').map((w): Mutation => ({ op: 'delete', kind: 'workout', id: w.id }));
}

test('logs weigh-ins over several days and sees the trend, rate and projected goal date', async ({ page }) => {
  await page.goto('/');
  await setGoal(page);
  await page.getByLabel('Goal weight').fill('170');
  await page.getByRole('button', { name: 'Save goal' }).click();
  await tab(page, 'Diary').click();

  // 183.0, 182.8, 182.6 lb: the trend moves a tenth of the way each day, 183 → 182.98 → 182.942.
  for (const [daysAgo, pounds] of [
    [13, '183.0'],
    [12, '182.8'],
    [11, '182.6'],
  ] as const) {
    await weighIn(page, daysAgo, pounds);
  }
  await page.getByRole('region', { name: 'Weight' }).getByRole('button', { name: /^Weight/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Weight' });
  await expect(sheet.getByTestId('trend-weight')).toHaveText('182.9 lb');
  await expect(sheet.getByTestId('weekly-rate')).toHaveText('Not enough data for a rate yet');
  await expect(sheet.getByTestId('projection')).toHaveText('Not enough data');
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  for (let daysAgo = 10; daysAgo >= 0; daysAgo--) await weighIn(page, daysAgo, (183 - 0.2 * (13 - daysAgo)).toFixed(1));
  await page.getByRole('region', { name: 'Weight' }).getByRole('button', { name: /^Weight/ }).click();
  await expect(sheet.getByTestId('weekly-rate')).toHaveText(/^−\d\.\d lb a week$/);
  await expect(sheet.getByTestId('projection')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  await expect(sheet.getByRole('figure', { name: 'Weight over 30 days' })).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'Weigh-ins' }).getByRole('listitem')).toHaveCount(14);
  await expect.poll(() => stored('weighIn').length, { timeout: 15_000 }).toBe(14);
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  // From a past day, picking a later day still finds its reading, and a day with none starts blank.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByRole('region', { name: 'Weight' }).getByRole('button', { name: 'Weigh in', exact: true }).click();
  const entry = page.getByRole('dialog', { name: 'Weigh-in' });
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
  await expect(page.getByRole('region', { name: 'Weight' }).getByTestId('tile-trend')).toBeVisible();
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
  // (9.8 − 1) MET × kg × 0.75 h, at the weight it was logged at.
  expect(synced?.kcal).toBe(Math.round(8.8 * (synced?.kg ?? 0) * 0.75));
  expect(synced?.kcal).toBe(burn);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Workouts' }).getByRole('button', { name: /^Running, 6 mph/ })).toContainText(shown(burn));
});

test('eats back a workout and sees remaining calories rise by its burn', async ({ page, request }) => {
  await seed(request, clearWorkouts());
  await page.goto('/');
  await setGoal(page);
  // Sedentary is the eat-back baseline too, so switching policy changes only the workout part.
  await page.getByRole('radio', { name: /^Sedentary/ }).click();
  await page.getByRole('button', { name: 'Save goal' }).click();

  await tab(page, 'Diary').click();
  await page.getByRole('region', { name: 'Workouts' }).getByRole('button', { name: 'Add workout' }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await logger.getByRole('region', { name: 'Gym' }).getByRole('button', { name: /^Strength training ?3\.5 MET/ }).click();
  await logger.getByRole('button', { name: '60 min', exact: true }).click();
  const burn = await kcalOf(page, 'workout-kcal');
  await logger.getByRole('button', { name: 'Log workout' }).click();
  await expect(page.getByText('Not added to your target.')).toBeVisible();
  await expect(page.getByTestId('kcal-workouts')).toBeHidden();

  const target = await kcalOf(page, 'kcal-target');
  const eaten = await kcalOf(page, 'kcal-eaten');
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target - eaten));

  await tab(page, 'Goal').click();
  await page.getByRole('radio', { name: 'Eat back workouts' }).click();
  await expect(page.getByTestId('policy-sentence')).toHaveText(/adds 100% of its calories to that day/);
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Goal saved' })).toBeVisible();

  await tab(page, 'Diary').click();
  await expect(page.getByTestId('kcal-workouts')).toHaveText(shown(burn));
  await expect(page.getByTestId('kcal-target')).toHaveText(shown(target));
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target + burn - eaten));
  await expect(page.getByText('Not added to your target.')).toBeHidden();
});
