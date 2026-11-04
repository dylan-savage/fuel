/**
 * The phase 2 day on a production build, with Open Food Facts served from recorded fixtures:
 * set a goal, look up a barcode, confirm and log it, watch remaining calories move, log a
 * recent and the same barcode offline, then reconnect and find every write in fuel.db.
 */
import { expect, test, type Page } from '@playwright/test';
import { Gtin } from '../src/domain/food.js';
import { kcalOf, openControlled, setGoal, stored, tab, typeBarcode } from './app.js';

const COKE = Gtin.parse('0049000000443');
const UNKNOWN_TO_OFF = '0028400999991';
const NOT_IN_OFF = '4006381333931';
/** US Coca-Cola, 591 ml bottle at 42.3 kcal per 100 ml, as recorded from Open Food Facts. */
const BOTTLE_KCAL = 250;
const shown = (n: number) => Math.abs(n).toLocaleString('en-US');

async function expectDay(page: Page, target: number, eaten: number) {
  await expect(page.getByTestId('kcal-eaten')).toHaveText(shown(eaten));
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target - eaten));
}

const cokeEntries = () => stored('entry').filter((e) => e.food.origin.kind === 'food' && e.food.name === 'Coca-Cola').length;

test('a day: goal, barcode to log, offline recents and scans, synced to fuel.db', async ({ page, context }) => {
  await openControlled(page);

  await setGoal(page);
  const target = await kcalOf(page, 'goal-kcal');
  expect(target).toBeGreaterThan(1200);
  await tab(page, 'Diary').click();
  await expect(page.getByTestId('kcal-target')).toHaveText(shown(target));
  const eaten = await kcalOf(page, 'kcal-eaten');
  await expect(page.getByTestId('kcal-remaining')).toHaveText(shown(target - eaten));

  await test.step('an unknown barcode goes through Open Food Facts to the confirm sheet', async () => {
    await typeBarcode(page, '049000000443');
    const confirm = page.getByRole('dialog', { name: 'Confirm food' });
    await expect(confirm.getByLabel('Name')).toHaveValue('Coca-Cola');
    await expect(confirm.getByTestId('preview-kcal')).toHaveText(String(BOTTLE_KCAL));
    await confirm.getByRole('button', { name: /^Add to library and log/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Logged Coca-Cola' })).toBeVisible();
    await expectDay(page, target, eaten + BOTTLE_KCAL);
    await expect.poll(() => stored('food').filter((f) => f.barcodes.includes(COKE) && !f.archived).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(cokeEntries, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  const syncedCokes = cokeEntries();

  await test.step('offline, a recent logs in one tap and the same barcode logs from the library', async () => {
    await context.setOffline(true);
    await tab(page, 'Add').click();
    await page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: 'Log Coca-Cola' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Logged Coca-Cola' })).toBeVisible();
    await expect(page.getByText('1 waiting')).toBeVisible();

    await typeBarcode(page, '049000000443');
    const sheet = page.getByRole('dialog', { name: 'Log food' });
    await expect(sheet.getByRole('heading', { name: 'Coca-Cola' })).toBeVisible();
    await sheet.getByRole('button', { name: /^Log to/ }).click();
    await expect(page.getByText('2 waiting')).toBeVisible();
    await expectDay(page, target, eaten + 3 * BOTTLE_KCAL);
    expect(cokeEntries()).toBe(syncedCokes);
  });

  await test.step('back online, both offline entries reach fuel.db', async () => {
    await context.setOffline(false);
    await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
    expect(cokeEntries()).toBe(syncedCokes + 2);
    expect(stored('goal').map((g) => g.policy)).toContainEqual({ kind: 'activity-level', level: 'moderate' });
    expect(stored('profile')[0]?.weightKg).toBeCloseTo(180 * 0.45359237, 3);
  });
});

test('a barcode the database misses can become a new food, which the next scan finds', async ({ page }) => {
  await page.goto('/');
  await typeBarcode(page, UNKNOWN_TO_OFF);
  await page.getByRole('button', { name: 'Create food' }).click();
  const editor = page.getByRole('dialog', { name: 'New food' });
  await editor.getByLabel('Name', { exact: true }).fill('Invented oat bar');
  await editor.getByLabel('Serving 1 size').fill('40');
  for (const [label, value] of [
    ['Calories', '180'],
    ['Protein', '4'],
    ['Carbs', '30'],
    ['Fat', '5'],
  ] as const) {
    await editor.getByLabel(label).fill(value);
  }
  await editor.getByRole('button', { name: 'Save food' }).click();
  const log = page.getByRole('dialog', { name: 'Log food' });
  await log.getByRole('button', { name: /^Log to/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Logged Invented oat bar' })).toBeVisible();

  await typeBarcode(page, UNKNOWN_TO_OFF);
  await expect(page.getByRole('dialog', { name: 'Log food' }).getByRole('heading', { name: 'Invented oat bar' })).toBeVisible();
  await expect.poll(() => stored('food').filter((f) => f.barcodes.includes(Gtin.parse(UNKNOWN_TO_OFF))).map((f) => f.name), { timeout: 15_000 }).toEqual(['Invented oat bar']);
});

test('a barcode the database misses can be quick added instead', async ({ page }) => {
  await page.goto('/');
  await typeBarcode(page, NOT_IN_OFF);
  await page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Quick add' }).click();
  const sheet = page.getByRole('dialog', { name: 'Quick add' });
  await sheet.getByLabel('What').fill('Invented snack');
  await sheet.getByLabel('Calories').fill('90');
  await sheet.getByRole('button', { name: /^Log to/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Logged Invented snack' })).toBeVisible();
});

test('search shows library foods at once and Open Food Facts results below', async ({ page }) => {
  await page.goto('/');
  await tab(page, 'Add').click();
  await page.getByLabel('Search foods').fill('greek yogurt');
  await expect(page.getByRole('list', { name: 'Online results' }).getByRole('listitem').first()).toBeVisible();
  await expect(page.getByText('No match in your foods.')).toBeVisible();
});
