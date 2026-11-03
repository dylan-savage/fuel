/**
 * Temporary, with src/client/bench.tsx. Runs the iPhone bench to the end on desktop WebKit and
 * proves it touches neither the fuel database nor the server, and stays out of the service worker.
 */
import { expect, test, type Page } from '@playwright/test';
import { Healthz } from '../src/protocol.js';
import { openControlled } from './app.js';

/** Everything in the fuel database, read past the app. */
function fuelContents(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
        const opening = indexedDB.open('fuel');
        opening.onerror = () => reject(new Error('could not open fuel'));
        opening.onsuccess = () => {
          const db = opening.result;
          const names = [...db.objectStoreNames];
          const transaction = db.transaction(names);
          const reads = names.map((name) => [name, transaction.objectStore(name).getAll()] as const);
          transaction.oncomplete = () => {
            db.close();
            resolve({ version: db.version, stores: Object.fromEntries(reads.map(([name, read]) => [name, read.result])) });
          };
        };
      }),
  );
}

const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));

test.describe('with every request visible', () => {
  test.use({ serviceWorkers: 'block' });

  test('runs start to finish, leaving the fuel database, the server and itself as they were', async ({ page, request }) => {
    test.setTimeout(240_000);
    const health = async () => Healthz.parse(await (await request.get('/healthz')).json());

    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Add to Snacks' }).click();
    await page.getByRole('button', { name: 'Quick add' }).click();
    const sheet = page.getByRole('dialog', { name: 'Quick add' });
    await sheet.getByLabel('What').fill('Must survive the bench');
    await sheet.getByLabel('Calories').fill('250');
    await sheet.getByRole('button', { name: 'Log to Snacks' }).click();
    await expect(page.getByText('1 waiting')).toBeVisible();

    await page.goto('/bench.html');
    const fuelBefore = await fuelContents(page);
    expect(fuelBefore.stores.entry, 'fuel holds something to lose').toHaveLength(1);
    expect(fuelBefore.stores.outbox, 'and a write only the phone has').toHaveLength(1);
    const healthBefore = await health();

    const seen: string[] = [];
    page.on('request', (r) => seen.push(new URL(r.url()).pathname));

    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('heading', { name: 'Seeding' })).toBeVisible();
    await expect.poll(() => databases(page), 'the run really holds a throwaway database').toContain('fuel-bench');
    await expect(page.getByRole('heading', { name: 'Measuring' })).toBeVisible({ timeout: 120_000 });

    const report = page.getByTestId('bench-report');
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('alert')).toBeHidden();
    const text = await report.innerText();
    console.warn(text);
    await page.screenshot({ path: 'test-results/bench.png', fullPage: true });

    expect(await page.getByTestId('bench-row').count(), 'every measure reported').toBe(8);
    expect(text).toMatch(/Day open\s+[\d.]+ ms (PASS|FAIL)/);
    expect(text).toMatch(/Set stored\s+[\d.]+ ms (PASS|FAIL)/);
    expect(text).toContain('median of 25 runs');
    expect(text).toContain('10000 docs');
    expect(text).toContain('fuel-bench deleted.');
    expect(text).toContain(await page.evaluate(() => navigator.userAgent));

    expect(await databases(page), 'it deleted its own database and only that').toEqual(['fuel']);
    expect(await fuelContents(page), 'the fuel database is untouched').toEqual(fuelBefore);
    expect(seen.filter((path) => path.startsWith('/api/')), 'it called no API').toEqual([]);
    expect(await health(), 'the server saw no sync').toEqual(healthBefore);
  });
});

test('stays out of the precache and the navigation fallback', async ({ page, context }) => {
  await openControlled(page);
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const entry of await (await caches.open(name)).keys()) paths.push(new URL(entry.url).pathname);
    }
    return paths;
  });
  expect(cached).toContain('/index.html');
  expect(cached.filter((path) => path.includes('bench'))).toEqual([]);

  await page.goto('/bench.html');
  await expect(page.getByRole('button', { name: 'Start' }), 'a controlled page reaches the bench, not the app').toBeVisible();

  await context.setOffline(true);
  await expect(page.goto('/bench.html'), 'offline it fails, because no fallback answers it').rejects.toThrow();
});
