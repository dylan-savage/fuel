/**
 * Phase 3 on a production build: build a recipe and log a serving, save a meal and log it in
 * one tap, copy yesterday's breakfast, and update a recipe after editing one of its foods.
 */
import { expect, test, type Page } from '@playwright/test';
import { stored, tab } from './app.js';

type Core = readonly [kcal: string, protein: string, carbs: string, fat: string];

/** Creates a library food measured per 100 g, then closes the log sheet that follows. */
async function newFood(page: Page, name: string, [kcal, protein, carbs, fat]: Core) {
  await tab(page, 'Add').click();
  await page.getByRole('button', { name: 'New food' }).click();
  const editor = page.getByRole('dialog', { name: 'New food' });
  await editor.getByLabel('Name', { exact: true }).fill(name);
  await editor.getByRole('radiogroup', { name: 'Nutrition per' }).getByRole('radio', { name: '100 g' }).click();
  for (const [label, value] of [
    ['Calories', kcal],
    ['Protein', protein],
    ['Carbs', carbs],
    ['Fat', fat],
  ] as const) {
    await editor.getByLabel(label).fill(value);
  }
  await editor.getByRole('button', { name: 'Save food' }).click();
  await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Cancel' }).click();
}

async function addIngredient(page: Page, name: string, grams: string) {
  await page.getByRole('dialog', { name: 'New recipe' }).getByRole('button', { name: 'Add ingredient' }).click();
  const picker = page.getByRole('dialog', { name: 'Add ingredient' });
  await picker.getByLabel('Search ingredients').fill(name);
  await picker
    .getByRole('list', { name: 'Your foods' })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  await picker.getByLabel('Amount').fill(grams);
  await picker.getByRole('button', { name: 'Add to recipe' }).click();
  await expect(picker).toBeHidden();
}

async function quickAdd(page: Page, meal: string, name: string, kcal: string) {
  await page.getByRole('button', { name: `Add to ${meal}` }).click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  const sheet = page.getByRole('dialog', { name: 'Quick add' });
  await sheet.getByLabel('What').fill(name);
  await sheet.getByLabel('Calories').fill(kcal);
  await sheet.getByRole('button', { name: `Log to ${meal}` }).click();
  await expect(page.getByRole('region', { name: meal }).getByText(name)).toBeVisible();
}

const meal = (page: Page, name: string) => page.getByRole('region', { name });

test.describe.configure({ mode: 'serial' });

test('builds a recipe from library foods and logs a serving', async ({ page }) => {
  await page.goto('/');
  await newFood(page, 'Ground beef', ['250', '26', '0', '15']);
  await newFood(page, 'Kidney beans', ['127', '8.7', '22.8', '0.5']);

  await tab(page, 'Add').click();
  await page.getByRole('radio', { name: 'Recipes' }).click();
  await page.getByRole('button', { name: 'New recipe' }).click();
  const builder = page.getByRole('dialog', { name: 'New recipe' });
  await builder.getByLabel('Name', { exact: true }).fill('Chili');
  await builder.getByLabel('Servings').fill('4');
  await builder.getByLabel('Cooked weight').fill('1600');
  await addIngredient(page, 'Ground beef', '500');
  await addIngredient(page, 'Kidney beans', '400');
  // 1250 + 508 kcal shared by 4 servings.
  await expect(builder.getByTestId('preview-kcal')).toHaveText('440');
  await builder.getByRole('button', { name: 'Save recipe' }).click();

  const log = page.getByRole('dialog', { name: 'Log food' });
  await expect(log.getByRole('radio', { name: '1 serving (400 g)' })).toHaveAttribute('aria-checked', 'true');
  await expect(log.getByTestId('preview-kcal')).toHaveText('440');
  await log.getByRole('radiogroup', { name: 'Meal' }).getByRole('radio', { name: 'Dinner' }).click();
  await log.getByRole('button', { name: 'Log to Dinner' }).click();

  await expect(meal(page, 'Dinner').getByText('Chili')).toBeVisible();
  await expect.poll(() => stored('entry').filter((e) => e.food.name === 'Chili' && e.food.origin.kind === 'recipe').length, { timeout: 15_000 }).toBe(1);
  expect(stored('recipe').find((r) => r.name === 'Chili')?.yield).toEqual({ servings: 4, cookedGrams: 1600 });
});

test('saves a meal from the diary and logs it into another meal in one tap', async ({ page }) => {
  await page.goto('/');
  await meal(page, 'Dinner').getByRole('button', { name: 'Dinner options' }).click();
  const menu = page.getByRole('dialog', { name: 'Dinner' });
  await menu.getByRole('button', { name: /^Save as a meal/ }).click();
  const save = page.getByRole('dialog', { name: 'Save as a meal' });
  await save.getByLabel('Name').fill('Chili night');
  await save.getByRole('button', { name: 'Save meal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Chili night' })).toBeVisible();

  await tab(page, 'Add').click();
  await page.getByRole('radiogroup', { name: 'Meal' }).getByRole('radio', { name: 'Lunch' }).click();
  await page.getByRole('radio', { name: 'Saved meals' }).click();
  await page.getByRole('list', { name: 'Saved meals' }).getByRole('button', { name: 'Log Chili night' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Logged Chili night to Lunch' })).toBeVisible();

  await tab(page, 'Diary').click();
  await expect(meal(page, 'Lunch').getByText('Chili')).toBeVisible();
  await expect.poll(() => stored('savedMeal').map((m) => m.name), { timeout: 15_000 }).toContain('Chili night');
});

test("copies yesterday's breakfast into today", async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Previous day' }).click();
  await quickAdd(page, 'Breakfast', 'Yesterday eggs', '300');
  await quickAdd(page, 'Breakfast', 'Yesterday toast', '150');
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await meal(page, 'Breakfast').getByRole('button', { name: 'Breakfast options' }).click();
  await page
    .getByRole('dialog', { name: 'Breakfast' })
    .getByRole('button', { name: /^Copy Breakfast from yesterday/ })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied 2 items to Breakfast' })).toBeVisible();
  await expect(meal(page, 'Breakfast').getByText('Yesterday eggs')).toBeVisible();
  await expect(meal(page, 'Breakfast').getByText('Yesterday toast')).toBeVisible();
  await expect.poll(() => stored('entry').filter((e) => e.food.name.startsWith('Yesterday ')).length, { timeout: 15_000 }).toBe(4);
});

test('asks before updating recipes and saved meals after a food edit, and never changes the diary', async ({ page }) => {
  await page.goto('/');
  await expect(meal(page, 'Dinner').getByText('Chili')).toBeVisible();
  await tab(page, 'Add').click();
  await page.getByLabel('Search foods').fill('ground beef');
  await page
    .getByRole('list', { name: 'Your foods' })
    .getByRole('button', { name: /^Ground beef/ })
    .click();
  await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Edit food' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit food' });
  await editor.getByLabel('Calories').fill('200');
  await editor.getByRole('button', { name: 'Save food' }).click();

  const ask = page.getByRole('alertdialog', { name: 'Also update 1 recipe?' });
  await ask.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Ground beef and updated 1 recipe' })).toBeVisible();
  const beefKcal = () =>
    stored('recipe')
      .find((r) => r.name === 'Chili')
      ?.ingredients.find((i) => i.food.name === 'Ground beef')?.food.nutrients.kcal;
  await expect.poll(beefKcal, { timeout: 15_000 }).toBe(200);
  expect(stored('entry').find((e) => e.food.name === 'Chili')?.food.nutrients.kcal).toBeCloseTo(1758 / 16);
});
