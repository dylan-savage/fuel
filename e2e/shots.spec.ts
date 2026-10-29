/**
 * Screenshots of the main screens on the iPhone profile, light and dark, for UI review.
 * Written to FUEL_SHOTS_DIR, else test-results/shots.
 */
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { setGoal, stored, tab, typeBarcode } from './app.js';

const dir = process.env.FUEL_SHOTS_DIR ?? join('test-results', 'shots');
/** Lay's Classic, never imported by any spec, so its barcode always reaches the confirm sheet. */
const LAYS = '028400090858';

test.describe.configure({ mode: 'serial' });

test('seeds a day worth photographing', async ({ page }) => {
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

    test(`photographs Today, the food sheet, the confirm sheet and the goal screen in ${colorScheme}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Breakfast' }).getByText('Overnight oats')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('region', { name: 'Lunch' }).getByText('Chicken burrito bowl')).toBeVisible();
      await page.screenshot({ path: join(dir, `today-${colorScheme}.png`), animations: 'disabled' });

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

      await tab(page, 'Goal').click();
      await expect(page.getByTestId('goal-kcal')).not.toHaveText('–');
      await page.screenshot({ path: join(dir, `goal-${colorScheme}.png`), animations: 'disabled' });
      // A full-page capture would paint the fixed tab bar mid-page.
      await page.screenshot({ path: join(dir, `goal-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar { display: none; }' });
    });
  });
}
