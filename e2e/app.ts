import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { parseDoc, type DocOf, type Kind, type Mutation } from '../src/domain/kinds.js';
import { ClientId, MutationId, Rev, SyncResponse, type SyncRequest, type WireMutation } from '../src/protocol.js';

const dbPath = join(process.env.FUEL_E2E_DIR ?? '', 'data', 'fuel.db');

/** Every live document of a kind in the mini's fuel.db, parsed as the server stored it. */
export function stored<K extends Kind>(kind: K): DocOf<K>[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = z.array(z.object({ body: z.string() })).parse(db.prepare('SELECT body FROM doc WHERE kind = ? AND body IS NOT NULL').all(kind));
    return rows.map((row) => {
      const parsed = parseDoc(kind, JSON.parse(row.body));
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.doc;
    });
  } finally {
    db.close();
  }
}

/**
 * Pushes documents to the mini as another phone would, for data a spec needs but does not
 * test the making of. The app pulls them on its next sync.
 */
export async function seed(request: APIRequestContext, mutations: readonly Mutation[]): Promise<void> {
  const wire = mutations.map((m, i): WireMutation => {
    const id = MutationId.parse(i + 1);
    return m.op === 'put' ? { op: 'put', id, kind: m.kind, docId: m.doc.id, doc: m.doc } : { op: 'delete', id, kind: m.kind, docId: m.id };
  });
  const body: SyncRequest = { clientId: ClientId.parse(randomUUID()), epoch: null, cursor: Rev.parse(0), mutations: wire };
  const res = await request.post('/api/sync', { data: body });
  expect(res.ok()).toBe(true);
  expect(SyncResponse.parse(await res.json()).rejected).toEqual([]);
}

/** Loads the app until the service worker controls it, so it can run with the network cut. */
export async function openControlled(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // A first install does not control the page that registered it.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

export async function openOffline(page: Page, context: BrowserContext) {
  await openControlled(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
}

/** Rows the phone holds in one of its IndexedDB tables. */
export function countOnPhone(page: Page, table: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const opening = indexedDB.open('fuel');
        opening.onerror = () => reject(new Error('could not open fuel'));
        opening.onsuccess = () => {
          const db = opening.result;
          const count = db.transaction(name).objectStore(name).count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
    table,
  );
}

export function tab(page: Page, name: 'Diary' | 'Add' | 'Train' | 'Goal') {
  return page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true });
}

/** A displayed kcal figure such as "2,241" as a number. */
export async function kcalOf(page: Page, testId: string): Promise<number> {
  return Number((await page.getByTestId(testId).textContent())?.replace(/,/g, ''));
}

/** Opens a row of the Goal screen, if it is not open already. */
export async function openRow(page: Page, name: string) {
  const row = page.locator('details.expand').filter({ has: page.locator('summary .row-name', { hasText: name }) });
  if (!(await row.evaluate((el) => el instanceof HTMLDetailsElement && el.open))) await row.locator('summary').click();
}

/** Saves the goal, if anything has changed. Save only appears when something has. */
export async function saveGoal(page: Page) {
  const save = page.getByRole('button', { name: 'Save goal' });
  if (await save.isVisible()) {
    await save.click();
    await expect(save).toBeHidden();
  }
}

/** Fills the profile sheet and saves a 1 lb a week loss at moderate activity, workouts not eaten back. */
export async function setGoal(page: Page) {
  await tab(page, 'Goal').click();
  await page.getByRole('button', { name: /^Your details/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Your details' });
  await sheet.getByRole('radio', { name: 'Male', exact: true }).click();
  await sheet.getByLabel('Birth date').fill('1990-06-15');
  await sheet.getByLabel('Height feet').fill('5');
  await sheet.getByLabel('Height inches').fill('11');
  await sheet.getByLabel('Weight').fill('180');
  await sheet.getByRole('button', { name: 'Save details' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('switch', { name: /^Count workouts/ }).uncheck();
  await openRow(page, 'Activity');
  await page.getByRole('radio', { name: /Moderately active/ }).click();
  await openRow(page, 'Weekly goal');
  await page.getByLabel('Weekly goal').selectOption({ label: 'Lose 1 lb a week' });
  await saveGoal(page);
}

/** Opens the Scan sheet from the button in Add's search row. */
export async function openScan(page: Page) {
  await tab(page, 'Add').click();
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  return page.getByRole('dialog', { name: 'Scan' });
}

/** Types a barcode on the Scan sheet and looks it up. */
export async function typeBarcode(page: Page, digits: string) {
  const scan = await openScan(page);
  await scan.getByLabel('Barcode number').fill(digits);
  await scan.getByRole('button', { name: 'Look up' }).click();
}
