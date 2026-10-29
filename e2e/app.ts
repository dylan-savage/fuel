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

export function tab(page: Page, name: 'Diary' | 'Add' | 'Scan' | 'Goal') {
  return page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true });
}

/** A displayed kcal figure such as "2,241" as a number. */
export async function kcalOf(page: Page, testId: string): Promise<number> {
  return Number((await page.getByTestId(testId).textContent())?.replace(/,/g, ''));
}

/** Fills the profile sheet and saves a 1 lb a week loss at moderate activity. */
export async function setGoal(page: Page) {
  await tab(page, 'Goal').click();
  await page.getByRole('button', { name: /Add your details|Male|Female/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Your details' });
  await sheet.getByRole('radio', { name: 'Male', exact: true }).click();
  await sheet.getByLabel('Birth date').fill('1990-06-15');
  await sheet.getByLabel('Height feet').fill('5');
  await sheet.getByLabel('Height inches').fill('11');
  await sheet.getByLabel('Weight').fill('180');
  await sheet.getByRole('button', { name: 'Save details' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('radio', { name: /Moderately active/ }).click();
  await page.getByLabel('Weekly goal').selectOption({ label: 'Lose 1 lb per week' });
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Goal saved' })).toBeVisible();
}

/** Types a barcode on the Scan screen and looks it up. */
export async function typeBarcode(page: Page, digits: string) {
  await tab(page, 'Scan').click();
  await page.getByLabel('Barcode number').fill(digits);
  await page.getByRole('button', { name: 'Look up' }).click();
}
