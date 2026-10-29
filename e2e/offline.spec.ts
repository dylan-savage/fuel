/**
 * The phase 1 promise on a production build served by the real server: the Home Screen app
 * opens and logs with the mini unreachable, and the write reaches fuel.db on reconnect.
 */
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { writeBarcode } from 'zxing-wasm/writer';
import { z } from 'zod';
import { Entry } from '../src/domain/diary.js';

const dbPath = join(process.env.FUEL_E2E_DIR ?? '', 'data', 'fuel.db');

/** Loads the app until the service worker controls it, then cuts the network. */
async function openOffline(page: Page, context: BrowserContext) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // A first install does not control the page that registered it.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'fuel' })).toBeVisible();
}

function loggedNames(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = z.array(z.object({ body: z.string() })).parse(db.prepare("SELECT body FROM doc WHERE kind = 'entry'").all());
    return rows.map((row) => Entry.parse(JSON.parse(row.body)).food.name);
  } finally {
    db.close();
  }
}

test('logs a quick add offline and syncs it to fuel.db on reconnect', async ({ page, context }) => {
  await openOffline(page, context);

  await page.getByLabel('What').fill('Airplane snack');
  await page.getByLabel('kcal').fill('250');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('1 waiting')).toBeVisible();
  await expect(page.getByTestId('kcal-total')).toHaveText('250');
  expect(loggedNames()).not.toContain('Airplane snack');

  await context.setOffline(false);
  await expect(page.getByText('1 waiting')).toBeHidden({ timeout: 15_000 });
  expect(loggedNames()).toContain('Airplane snack');
});

test('decodes a barcode photo offline with the precached wasm', async ({ page, context }) => {
  const { image } = await writeBarcode('049000000443', { format: 'UPCA', scale: 4 });
  if (!image) throw new Error('could not draw the barcode');
  await openOffline(page, context);

  await page.getByRole('button', { name: 'Scan' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'label.png',
    mimeType: 'image/png',
    buffer: Buffer.from(await image.arrayBuffer()),
  });
  await expect(page.getByTestId('gtin')).toHaveText('0049000000443');
});
