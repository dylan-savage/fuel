/**
 * Phase 6 on a production build: water added offline reaches fuel.db and is still there
 * after reconnecting, and a fast started offline keeps its real start when it syncs and is
 * ended online.
 */
import { expect, test } from '@playwright/test';
import { openOffline, stored } from './app.js';

/** Fasts in fuel.db that no phone has ended. */
function openOnServer() {
  const ended = new Set(stored('fastEnd').map((end) => end.fastId));
  return stored('fast').filter((fast) => !ended.has(fast.id));
}

test('adds water offline and still shows it after reconnecting', async ({ page, context }) => {
  await openOffline(page, context);
  const total = page.getByTestId('water-total');
  await expect(total).toBeVisible();
  const before = Number(await total.textContent());
  const onServer = stored('water').length;

  await page.getByRole('button', { name: /^Water/ }).click();
  const water = page.getByRole('dialog', { name: 'Water' });
  await water.getByRole('button', { name: 'Add 8 fl oz of water' }).click();
  await water.getByRole('button', { name: 'Add 16 fl oz of water' }).click();
  await water.getByRole('button', { name: 'Done' }).click();
  await expect(total).toHaveText(String(before + 24));
  await expect(page.getByText('2 waiting')).toBeVisible();
  expect(stored('water')).toHaveLength(onServer);

  await context.setOffline(false);
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  expect(stored('water')).toHaveLength(onServer + 2);
  await page.reload();
  await expect(page.getByTestId('water-total')).toHaveText(String(before + 24));
});

test('logs another amount of water and removes a drink with undo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Water/ }).click();
  const water = page.getByRole('dialog', { name: 'Water' });
  const drink = water.getByRole('button', { name: /^Remove 7\.5 fl oz/ });

  await expect(water.getByRole('button', { name: /^Add \d.* fl oz$/ })).toBeHidden();
  await water.getByLabel('Other amount').fill('7.5');
  await water.getByRole('button', { name: 'Add 7.5 fl oz' }).click();
  await expect(drink).toBeVisible();

  await drink.click();
  await expect(drink).toBeHidden();
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(drink).toBeVisible();
});

test('starts a fast offline and ends it online, keeping the real start time', async ({ page, context }) => {
  await openOffline(page, context);
  const row = page.getByRole('button', { name: /^Fasting/ });
  await expect(row).toContainText('Off');
  await row.click();
  const sheet = page.getByRole('dialog', { name: 'Fasting' });
  const tapped = Date.now();
  await sheet.getByRole('button', { name: 'Start fast' }).click();
  await expect(sheet.getByTestId('fast-clock')).toHaveText(/^0:00:0[2-9]$/, { timeout: 10_000 });
  await expect(page.getByText('1 waiting')).toBeVisible();
  expect(openOnServer()).toEqual([]);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('fast-elapsed')).toHaveText('0 m');

  await context.setOffline(false);
  const reconnected = Date.now();
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  const [synced, ...others] = openOnServer();
  expect(others).toEqual([]);
  expect(synced?.startedAt).toBeGreaterThanOrEqual(tapped);
  expect(synced?.startedAt).toBeLessThan(reconnected - 1500);

  await row.click();
  await sheet.getByRole('button', { name: 'End fast' }).click();
  await expect(sheet.getByRole('button', { name: 'Start fast' })).toBeVisible();
  await expect.poll(() => stored('fastEnd').find((end) => end.fastId === synced?.id)?.endedAt, { timeout: 15_000 }).toBeGreaterThanOrEqual(reconnected);
  expect(stored('fast').find((f) => f.id === synced?.id)?.startedAt).toBe(synced?.startedAt);
});
