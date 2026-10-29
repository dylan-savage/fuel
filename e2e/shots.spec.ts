/**
 * Screenshots of the main screens on the iPhone profile, light and dark, for UI review.
 * Written to FUEL_SHOTS_DIR, else test-results/shots.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { snapshotOf, type Food, type Ingredient, type Serving } from '../src/domain/food.js';
import { HOUR_MS, ML_PER_FL_OZ, type Fast, type FastEnd } from '../src/domain/habits.js';
import { FastEndId, FastId, FoodId, Millis, RecipeId, SavedMealId, WaterId } from '../src/domain/ids.js';
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

test('seeds a day worth photographing', async ({ page, request }) => {
  await seed(request, [...reuseDocs(), ...habitDocs()]);
  await page.goto('/');
  await setGoal(page);

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
  });
}
