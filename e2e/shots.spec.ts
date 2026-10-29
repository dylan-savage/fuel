/**
 * Screenshots of the main screens on the iPhone profile, light and dark, for UI review.
 * Written to FUEL_SHOTS_DIR, else test-results/shots.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { weighInId } from '../src/domain/body.js';
import { makeWorkout, metDraft } from '../src/domain/burn.js';
import { snapshotOf, type Food, type Ingredient, type Serving } from '../src/domain/food.js';
import { HOUR_MS, ML_PER_FL_OZ, type Fast, type FastEnd } from '../src/domain/habits.js';
import { KG_PER_LB } from '../src/domain/goals.js';
import { FastEndId, FastId, FoodId, Millis, RecipeId, SavedMealId, WaterId, WorkoutId, addDays } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Recipe, SavedMeal } from '../src/domain/reuse.js';
import { seed, setGoal, stored, tab, typeBarcode } from './app.js';

const dir = process.env.FUEL_SHOTS_DIR ?? join('test-results', 'shots');
/** Lay's Classic, never imported by any spec, so its barcode always reaches the confirm sheet. */
const LAYS = '028400090858';

function libraryFood(name: string, nutrients: Food['nutrients'], servings: Serving[] = []): Food {
  return { id: FoodId.parse(randomUUID()), name, unit: 'g', nutrients, servings, barcodes: [], source: { kind: 'user' }, archived: false };
}
const grams = (food: Food, amount: number): Ingredient => ({ food: snapshotOf(food), quantity: { kind: 'amount', amount } });

/** A recipe and a saved meal with their foods, so the reuse screens have something to show. */
function reuseDocs(): Mutation[] {
  const chicken = libraryFood('Chicken thigh', { kcal: 177, protein: 24, carbs: 0, fat: 8.2 });
  const rice = libraryFood('Jasmine rice, cooked', { kcal: 129, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 });
  const broccoli = libraryFood('Broccoli', { kcal: 34, protein: 2.8, carbs: 6.6, fat: 0.4, fiber: 2.6 });
  const pot: Serving = { label: '1 pot', amount: 170 };
  const yogurt = libraryFood('Greek yogurt', { kcal: 97, protein: 9, carbs: 3.6, fat: 5 }, [pot]);
  const berries = libraryFood('Blueberries', { kcal: 57, protein: 0.7, carbs: 14.5, fat: 0.3, fiber: 2.4 });
  const granola = libraryFood('Granola', { kcal: 471, protein: 10, carbs: 64, fat: 20, fiber: 5.3 });
  const bowl: Recipe = {
    id: RecipeId.parse(randomUUID()),
    name: 'Chicken rice bowl',
    ingredients: [grams(chicken, 600), grams(rice, 750), grams(broccoli, 300)],
    yield: { servings: 4, cookedGrams: 1550 },
    archived: false,
  };
  const breakfast: SavedMeal = {
    id: SavedMealId.parse(randomUUID()),
    name: 'Usual breakfast',
    items: [{ food: snapshotOf(yogurt), quantity: { kind: 'serving', serving: pot, count: 1 } }, grams(berries, 80), grams(granola, 40)],
    archived: false,
  };
  return [
    ...[chicken, rice, broccoli, yogurt, berries, granola].map((doc): Mutation => ({ op: 'put', kind: 'food', doc })),
    { op: 'put', kind: 'recipe', doc: bowl },
    { op: 'put', kind: 'savedMeal', doc: breakfast },
  ];
}

test.describe.configure({ mode: 'serial' });

/**
 * Today's drinks, a fast 13.4 hours in and a week of finished ones, replacing any fasts and
 * drinks other specs left, so the timer and history photograph the same every run.
 */
function habitDocs(): Mutation[] {
  const now = Date.now();
  const today = localDate();
  const cleared = [
    ...stored('fast').map((f): Mutation => ({ op: 'delete', kind: 'fast', id: f.id })),
    ...stored('fastEnd').map((e): Mutation => ({ op: 'delete', kind: 'fastEnd', id: e.id })),
    ...stored('water').map((w): Mutation => ({ op: 'delete', kind: 'water', id: w.id })),
  ];
  const drinks = [16, 8, 16, 12].map((oz, i): Mutation => ({
    op: 'put',
    kind: 'water',
    doc: { id: WaterId.parse(randomUUID()), date: today, ml: oz * ML_PER_FL_OZ, loggedAt: Millis.parse(now - (4 - i) * HOUR_MS) },
  }));
  const start = now - 13.4 * HOUR_MS;
  const past = [16.5, 17.2, 16.1, 16.8, 14.6, 18.3, 16.2].flatMap((hours, i): Mutation[] => {
    const fast: Fast = { id: FastId.parse(randomUUID()), startedAt: Millis.parse(start - (i + 1) * 24 * HOUR_MS), targetHours: 16 };
    const end: FastEnd = { id: FastEndId.parse(randomUUID()), fastId: fast.id, endedAt: Millis.parse(fast.startedAt + hours * HOUR_MS) };
    return [
      { op: 'put', kind: 'fast', doc: fast },
      { op: 'put', kind: 'fastEnd', doc: end },
    ];
  });
  const open: Fast = { id: FastId.parse(randomUUID()), startedAt: Millis.parse(start), targetHours: 16 };
  return [...cleared, ...drinks, { op: 'put', kind: 'fast', doc: open }, ...past];
}

/**
 * Ninety days of weigh-ins drifting down with day-to-day noise and a few skipped days, and
 * two workouts today, replacing any other specs left.
 */
function bodyDocs(): Mutation[] {
  const today = localDate();
  const cleared = [
    ...stored('weighIn').map((w): Mutation => ({ op: 'delete', kind: 'weighIn', id: w.id })),
    ...stored('workout').map((w): Mutation => ({ op: 'delete', kind: 'workout', id: w.id })),
  ];
  const weighIns = Array.from({ length: 90 }, (_, i) => i).flatMap((i): Mutation[] => {
    if (i % 9 === 4 || i % 13 === 7) return [];
    const date = addDays(today, i - 89);
    const pounds = 192 - 0.12 * i + 1.1 * Math.sin(i * 1.7) + 0.6 * Math.sin(i * 0.37 + 1);
    return [{ op: 'put', kind: 'weighIn', doc: { id: weighInId(date), date, kg: pounds * KG_PER_LB, loggedAt: Millis.parse(Date.now()) } }];
  });
  const kg = 181.4 * KG_PER_LB;
  const workouts = [metDraft('strength', 50), metDraft('walk_3_5', 30)].map((draft, i): Mutation => ({
    op: 'put',
    kind: 'workout',
    doc: makeWorkout(draft, { id: WorkoutId.parse(randomUUID()), date: today, kg, loggedAt: Millis.parse(Date.now() - (3 - i) * HOUR_MS) }),
  }));
  return [...cleared, ...weighIns, ...workouts];
}

test('seeds a day worth photographing', async ({ page, request }) => {
  await seed(request, [...reuseDocs(), ...habitDocs(), ...bodyDocs()]);
  await page.goto('/');
  await setGoal(page);
  await page.getByLabel('Goal weight').fill('170');
  await page.getByRole('button', { name: 'Save goal' }).click();

  await tab(page, 'Diary').click();
  await page.getByRole('button', { name: 'Add to Breakfast' }).click();
  await page.getByRole('button', { name: 'New food' }).click();
  const editor = page.getByRole('dialog', { name: 'New food' });
  await editor.getByLabel('Name', { exact: true }).fill('Overnight oats');
  await editor.getByLabel('Serving 1 name').fill('1 jar');
  await editor.getByLabel('Serving 1 size').fill('250');
  for (const [label, value] of [
    ['Calories', '380'],
    ['Protein', '18'],
    ['Carbs', '52'],
    ['Fat', '11'],
    ['Fiber', '8'],
  ] as const) {
    await editor.getByLabel(label).fill(value);
  }
  await editor.getByRole('button', { name: 'Save food' }).click();
  await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Log to Breakfast' }).click();

  await page.getByRole('button', { name: 'Add to Lunch' }).click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  const quick = page.getByRole('dialog', { name: 'Quick add' });
  await quick.getByLabel('What').fill('Chicken burrito bowl');
  await quick.getByLabel('Calories').fill('760');
  await quick.getByLabel('Protein').fill('48');
  await quick.getByRole('button', { name: 'Log to Lunch' }).click();
  await expect.poll(() => stored('entry').map((e) => e.food.name), { timeout: 15_000 }).toContain('Chicken burrito bowl');
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test(`photographs Today, habits, the food and reuse sheets and the goal screen in ${colorScheme}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Breakfast' }).getByText('Overnight oats')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('region', { name: 'Lunch' }).getByText('Chicken burrito bowl')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Fasting' }).getByTestId('fast-elapsed')).toHaveText(/^13:/);
      await page.screenshot({ path: join(dir, `today-${colorScheme}.png`), animations: 'disabled' });

      await page.getByRole('region', { name: 'Fasting' }).getByRole('button', { name: /^Fasting/ }).click();
      const timer = page.getByRole('dialog', { name: 'Fasting' });
      await expect(timer.getByRole('list', { name: 'Past fasts' }).getByRole('listitem')).toHaveCount(7);
      await page.screenshot({ path: join(dir, `fast-timer-${colorScheme}.png`), animations: 'disabled' });
      await timer.getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('region', { name: 'Water' }).getByRole('button', { name: /^Water/ }).click();
      const water = page.getByRole('dialog', { name: 'Water' });
      await expect(water.getByRole('list', { name: 'Drinks' }).getByRole('listitem')).toHaveCount(4);
      await page.screenshot({ path: join(dir, `water-sheet-${colorScheme}.png`), animations: 'disabled' });
      await water.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Add').click();
      await page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: /^Overnight oats/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Log food' });
      await expect(sheet.getByTestId('preview-kcal')).toHaveText('380');
      await sheet.getByLabel('Amount').fill('1.5');
      await expect(sheet.getByTestId('preview-kcal')).toHaveText('570');
      await page.screenshot({ path: join(dir, `food-sheet-${colorScheme}.png`), animations: 'disabled' });
      await sheet.getByRole('button', { name: 'Cancel' }).click();

      await typeBarcode(page, LAYS);
      const confirm = page.getByRole('dialog', { name: 'Confirm food' });
      await expect(confirm.getByLabel('Name')).toHaveValue('Classic Potato Chips');
      await page.screenshot({ path: join(dir, `confirm-sheet-${colorScheme}.png`), animations: 'disabled' });
      await confirm.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Add').click();
      await page.getByRole('radio', { name: 'Recipes' }).click();
      await page.getByRole('list', { name: 'Recipes' }).getByRole('button', { name: /^Chicken rice bowl/ }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Edit recipe' }).click();
      const builder = page.getByRole('dialog', { name: 'Edit recipe' });
      await expect(builder.getByRole('list', { name: 'Ingredients' }).getByText('Broccoli')).toBeVisible();
      await page.screenshot({ path: join(dir, `recipe-builder-${colorScheme}.png`), animations: 'disabled' });
      await builder.getByRole('button', { name: 'Cancel' }).click();

      await page.getByLabel('Search foods').fill('chicken thigh');
      await page.getByRole('list', { name: 'Your foods' }).getByRole('button', { name: /^Chicken thigh/ }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Edit food' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit food' });
      await editor.getByLabel('Calories').fill('180');
      await editor.getByRole('button', { name: 'Save food' }).click();
      const ask = page.getByRole('alertdialog', { name: 'Also update 1 recipe?' });
      await expect(ask).toBeVisible();
      await page.screenshot({ path: join(dir, `food-edit-prompt-${colorScheme}.png`), animations: 'disabled' });
      await ask.getByRole('button', { name: 'Not now' }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Cancel' }).click();
      await page.getByLabel('Search foods').fill('');

      await page.getByRole('radio', { name: 'Saved meals' }).click();
      const saved = page.getByRole('list', { name: 'Saved meals' });
      await expect(saved.getByText('Usual breakfast')).toBeVisible();
      await page.screenshot({ path: join(dir, `saved-meals-${colorScheme}.png`), animations: 'disabled' });
      await saved.getByRole('button', { name: /^Usual breakfast/ }).click();
      const mealSheet = page.getByRole('dialog', { name: 'Saved meal' });
      await expect(mealSheet.getByText('Granola')).toBeVisible();
      await page.screenshot({ path: join(dir, `saved-meal-sheet-${colorScheme}.png`), animations: 'disabled' });
      await mealSheet.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Diary').click();
      await page.getByRole('button', { name: 'Breakfast options' }).click();
      const menu = page.getByRole('dialog', { name: 'Breakfast' });
      await expect(menu.getByRole('button', { name: /^Save as a meal/ })).toBeEnabled();
      await page.screenshot({ path: join(dir, `meal-menu-${colorScheme}.png`), animations: 'disabled' });
      await menu.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Goal').click();
      await expect(page.getByTestId('goal-kcal')).not.toHaveText('–');
      // The toast from saving a food earlier in this pass would cover the form.
      await page.screenshot({ path: join(dir, `goal-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      // A full-page capture would paint the fixed tab bar mid-page.
      await page.screenshot({ path: join(dir, `goal-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; }' });
    });

    test(`photographs weight, workouts and the budget choice in ${colorScheme}`, async ({ page }) => {
      await page.goto('/');
      const tile = page.getByRole('region', { name: 'Weight' });
      await expect(tile.getByTestId('tile-trend')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('region', { name: 'Workouts' }).getByText('Strength training')).toBeVisible();

      await tile.getByRole('button', { name: /^Weight/ }).click();
      const weight = page.getByRole('dialog', { name: 'Weight' });
      await expect(weight.getByTestId('projection')).not.toHaveText('Not enough data');
      await page.screenshot({ path: join(dir, `weight-${colorScheme}.png`), animations: 'disabled' });
      await weight.getByRole('radio', { name: '90 days' }).click();
      await page.screenshot({ path: join(dir, `weight-90-days-${colorScheme}.png`), animations: 'disabled' });
      await weight.getByRole('button', { name: 'Cancel' }).click();

      await tile.getByRole('button', { name: 'Weigh in', exact: true }).click();
      const entry = page.getByRole('dialog', { name: 'Weigh-in' });
      await entry.getByLabel('Weight').fill('181.2');
      await page.screenshot({ path: join(dir, `weigh-in-${colorScheme}.png`), animations: 'disabled' });
      await entry.getByRole('button', { name: 'Cancel' }).click();

      const workouts = page.getByRole('region', { name: 'Workouts' });
      await workouts.getByRole('button', { name: 'Add workout' }).click();
      const logger = page.getByRole('dialog', { name: 'Add workout' });
      await expect(logger.getByRole('list', { name: 'Recent workouts' })).toBeVisible();
      await page.screenshot({ path: join(dir, `workout-picker-${colorScheme}.png`), animations: 'disabled' });
      await logger.getByRole('region', { name: 'Running' }).getByRole('button', { name: /^Running, 6 mph/ }).click();
      await logger.getByRole('button', { name: '45 min', exact: true }).click();
      await expect(logger.getByTestId('workout-kcal')).not.toHaveText('–');
      await page.screenshot({ path: join(dir, `workout-logger-${colorScheme}.png`), animations: 'disabled' });
      await logger.getByRole('button', { name: 'Cancel' }).click();

      await workouts.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `today-workouts-${colorScheme}.png`), animations: 'disabled' });
      await page.screenshot({ path: join(dir, `today-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; }' });

      await tab(page, 'Goal').click();
      const choice = page.getByRole('radiogroup', { name: 'Workouts and your target' });
      await choice.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -60));
      await page.screenshot({ path: join(dir, `goal-policy-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await choice.getByRole('radio', { name: 'Eat back workouts' }).click();
      await expect(page.getByTestId('policy-sentence')).toContainText('adds 100%');
      await page.screenshot({ path: join(dir, `goal-eat-back-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
    });
  });
}
