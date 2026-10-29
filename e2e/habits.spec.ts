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
  const water = page.getByRole('region', { name: 'Water' });
  const total = water.getByTestId('water-total');
  await expect(total).toBeVisible();
  const before = Number(await total.textContent());
  const onServer = stored('water').length;

  await water.getByRole('button', { name: 'Add 8 fl oz of water' }).click();
  await water.getByRole('button', { name: 'Add 16 fl oz of water' }).click();
  await expect(total).toHaveText(String(before + 24));
  await expect(page.getByText('2 waiting')).toBeVisible();
  expect(stored('water')).toHaveLength(onServer);

  await context.setOffline(false);
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  expect(stored('water')).toHaveLength(onServer + 2);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Water' }).getByTestId('water-total')).toHaveText(String(before + 24));
});

test('starts a fast offline and ends it online, keeping the real start time', async ({ page, context }) => {
  await openOffline(page, context);
  const tile = page.getByRole('region', { name: 'Fasting' });
  const tapped = Date.now();
  await tile.getByRole('button', { name: 'Start fast' }).click();
  await expect(tile.getByTestId('fast-elapsed')).toHaveText(/^0:00:0[2-9]$/, { timeout: 10_000 });
  await expect(page.getByText('1 waiting')).toBeVisible();
  expect(openOnServer()).toEqual([]);

  await context.setOffline(false);
  const reconnected = Date.now();
  await expect(page.getByText(/\d+ waiting/)).toBeHidden({ timeout: 15_000 });
  const [synced, ...others] = openOnServer();
  expect(others).toEqual([]);
  expect(synced?.startedAt).toBeGreaterThanOrEqual(tapped);
  expect(synced?.startedAt).toBeLessThan(reconnected - 1500);

  await tile.getByRole('button', { name: 'End fast' }).click();
  await expect(tile.getByRole('button', { name: 'Start fast' })).toBeVisible();
  await expect.poll(() => stored('fastEnd').find((end) => end.fastId === synced?.id)?.endedAt, { timeout: 15_000 }).toBeGreaterThanOrEqual(reconnected);
  expect(stored('fast').find((f) => f.id === synced?.id)?.startedAt).toBe(synced?.startedAt);
});
