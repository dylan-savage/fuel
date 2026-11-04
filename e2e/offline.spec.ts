/**
 * The phase 1 promise on a production build served by the real server: the Home Screen app
 * opens and logs with the mini unreachable, and the write reaches fuel.db on reconnect.
 */
import { expect, test } from '@playwright/test';
import { writeBarcode } from 'zxing-wasm/writer';
import { openOffline, openScan, stored } from './app.js';

test('logs a quick add offline and syncs it to fuel.db on reconnect', async ({ page, context }) => {
  await openOffline(page, context);

  await page.getByRole('button', { name: 'Add to Snacks' }).click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  const sheet = page.getByRole('dialog', { name: 'Quick add' });
  await sheet.getByLabel('What').fill('Airplane snack');
  await sheet.getByLabel('Calories').fill('250');
  await sheet.getByRole('button', { name: 'Log to Snacks' }).click();
  await expect(page.getByText('1 waiting')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Snacks' }).getByText('Airplane snack')).toBeVisible();
  expect(stored('entry').map((e) => e.food.name)).not.toContain('Airplane snack');

  await context.setOffline(false);
  await expect(page.getByText('1 waiting')).toBeHidden({ timeout: 15_000 });
  expect(stored('entry').map((e) => e.food.name)).toContain('Airplane snack');
});

test('decodes a barcode photo offline with the precached scanner and wasm', async ({ page, context }) => {
  const { image } = await writeBarcode('049000000443', { format: 'UPCA', scale: 4 });
  if (!image) throw new Error('could not draw the barcode');
  await openOffline(page, context);

  const scan = await openScan(page);
  await scan.locator('input[type=file]').setInputFiles({
    name: 'label.png',
    mimeType: 'image/png',
    buffer: Buffer.from(await image.arrayBuffer()),
  });
  await expect(page.getByTestId('gtin')).toHaveText('0049000000443');
});
