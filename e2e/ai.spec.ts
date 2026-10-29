/**
 * AI quick log in WebKit on the iPhone profile. The mini runs with no API key, so its route
 * answers 503. The other tests answer /api/ai/parse in the browser with the real adapter over
 * the replies in test/ai-replies.ts, run on the request the phone built.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Gtin, type Food } from '../src/domain/food.js';
import { FoodId } from '../src/domain/ids.js';
import { AiParseRequest } from '../src/protocol.js';
import { createAiParser } from '../src/server/ai.js';
import { BREAKFAST, breakfastReply, labelReply, plateReply, stubMessages } from '../test/ai-replies.js';
import { openOffline, seed, stored, tab, typeBarcode } from './app.js';

const dir = process.env.FUEL_SHOTS_DIR ?? join('test-results', 'shots');
const photo = (name: 'label' | 'plate') => join(import.meta.dirname, '..', 'test', 'fixtures', 'ai', `${name}.jpg`);
const UNKNOWN_TO_OFF = '0028400999991';
const NOT_IN_LIBRARY = '4006381333931';

const sourdough: Food = {
  id: FoodId.parse(randomUUID()),
  name: 'Sourdough toast',
  unit: 'g',
  nutrients: { kcal: 250, protein: 9, carbs: 48, fat: 2 },
  servings: [{ label: '1 slice', amount: 50 }],
  barcodes: [],
  source: { kind: 'user' },
  archived: false,
};

async function answerFromFixtures(page: Page): Promise<AiParseRequest[]> {
  const sent: AiParseRequest[] = [];
  await page.route('**/api/ai/parse', async (route) => {
    const req = AiParseRequest.parse(route.request().postDataJSON());
    sent.push(req);
    const reply = req.kind === 'text' ? breakfastReply(null) : req.subject === 'plate' ? plateReply : labelReply;
    const outcome = await createAiParser({ messages: stubMessages(reply), model: 'claude-opus-5-5' }).parse(req);
    await route.fulfill(outcome.ok ? { json: outcome.answer } : { status: 502, json: { error: outcome.reason } });
  });
  return sent;
}

async function describeMeal(page: Page) {
  await tab(page, 'Add').click();
  await page.getByLabel('Describe what you ate').fill(BREAKFAST);
  await page.getByRole('button', { name: 'Log with AI' }).click();
  return page.getByRole('dialog', { name: 'AI quick log' });
}

test.describe('online', () => {
  // page.route does not see requests a service worker handles.
  test.use({ serviceWorkers: 'block' });

  test('says AI is not set up while the mini has no API key', async ({ page }) => {
    await page.goto('/');
    await describeMeal(page);
    await expect(page.getByRole('alert')).toHaveText('AI is not set up on the mini yet. It needs an Anthropic API key.');
  });

  test('describes a meal, swaps a draft to his own food, drops one and logs the rest in one commit', async ({ page, request }) => {
    await seed(request, [{ op: 'put', kind: 'food', doc: sourdough }]);
    const sent = await answerFromFixtures(page);
    await page.goto('/');
    await tab(page, 'Add').click();
    await page.getByLabel('Search foods').fill('sourdough');
    await expect(page.getByRole('list', { name: 'Your foods' }).getByText('Sourdough toast')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Search foods').fill('');

    const review = await describeMeal(page);
    const drafts = review.getByRole('list', { name: 'Drafts' });
    await expect(drafts.getByRole('listitem')).toHaveCount(4);
    expect(sent[0]?.foods.map((f) => f.name)).toContain('Sourdough toast');

    const toast = drafts.getByRole('listitem', { name: 'Sourdough toast' });
    await expect(toast.getByTestId('draft-kcal')).toHaveText('145 kcal');
    await toast.getByRole('radiogroup', { name: 'Log Sourdough toast as' }).getByRole('radio', { name: 'Sourdough toast' }).click();
    await expect(toast.getByText(/^Your food/)).toBeVisible();
    await expect(toast.getByTestId('draft-kcal')).toHaveText('125 kcal');

    await drafts.getByRole('button', { name: 'Remove Butter' }).click();
    await expect(drafts.getByRole('listitem')).toHaveCount(3);
    await expect(review.getByTestId('preview-kcal')).toHaveText(String(143 + 125 + 380));

    await review.getByRole('radio', { name: 'Breakfast' }).click();
    await review.getByRole('button', { name: 'Log 3 items to Breakfast' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Logged 3 items to Breakfast' })).toBeVisible();
    const breakfast = page.getByRole('region', { name: 'Breakfast' });
    for (const name of ['Egg', 'Sourdough toast', 'Overnight oats']) await expect(breakfast.getByText(name, { exact: true }).first()).toBeVisible();

    await expect
      .poll(() => stored('entry').filter((e) => e.food.origin.kind === 'food' && e.food.origin.id === sourdough.id).length, { timeout: 15_000 })
      .toBe(1);
    const logged = stored('entry').filter((e) => ['Egg', 'Sourdough toast', 'Overnight oats'].includes(e.food.name));
    const commit = logged.toSorted((a, b) => a.loggedAt - b.loggedAt).slice(-3);
    expect(commit.map((e) => e.loggedAt - (commit[0]?.loggedAt ?? 0))).toEqual([0, 1, 2]);
  });

  test('a plate photo opens a draft for each food on the plate', async ({ page }) => {
    const sent = await answerFromFixtures(page);
    await page.goto('/');
    await tab(page, 'Add').click();
    await page.getByLabel('Plate photo').setInputFiles(photo('plate'));
    const review = page.getByRole('dialog', { name: 'AI quick log' });
    await expect(review.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toHaveCount(5);
    expect(sent[0]).toMatchObject({ kind: 'photo', subject: 'plate', mediaType: 'image/jpeg' });
  });

  test('a barcode the database misses is read from its label, confirmed and found by the next scan', async ({ page }) => {
    const sent = await answerFromFixtures(page);
    await page.goto('/');
    await typeBarcode(page, UNKNOWN_TO_OFF);
    await expect(page.getByText('Open Food Facts does not know this product.')).toBeVisible();
    await page.getByLabel('Photograph the label').setInputFiles(photo('label'));

    const confirm = page.getByRole('dialog', { name: 'Confirm food' });
    await expect(confirm.getByLabel('Name')).toHaveValue('Cheerios');
    await expect(confirm.getByText('From AI. Check it against the label.')).toBeVisible();
    await expect(confirm.getByTestId('preview-kcal')).toHaveText('100');
    const shrunk = sent[0];
    if (shrunk?.kind !== 'photo') throw new Error('no photo sent');
    expect(shrunk.mediaType).toBe('image/jpeg');
    expect(Buffer.from(shrunk.base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    await confirm.getByRole('button', { name: /^Add to library and log/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Logged Cheerios' })).toBeVisible();
    await typeBarcode(page, UNKNOWN_TO_OFF);
    await expect(page.getByRole('dialog', { name: 'Log food' }).getByRole('heading', { name: 'Cheerios' })).toBeVisible();
    await expect.poll(() => stored('food').filter((f) => f.barcodes.includes(Gtin.parse(UNKNOWN_TO_OFF)) && f.source.kind === 'ai').length, { timeout: 15_000 }).toBe(1);
  });
});

const UNREACHABLE = 'AI needs the mini, which cannot be reached right now.';

async function offlineAdd(page: Page, context: BrowserContext) {
  await openOffline(page, context);
  await tab(page, 'Add').click();
  const quickLog = page.getByRole('region', { name: 'AI quick log' });
  await expect(quickLog.getByText(UNREACHABLE)).toBeVisible({ timeout: 15_000 });
  return quickLog;
}

test('AI is off, with the reason, while the mini cannot be reached', async ({ page, context }) => {
  const quickLog = await offlineAdd(page, context);
  await expect(quickLog.getByLabel('Describe what you ate')).toBeDisabled();
  await expect(quickLog.getByLabel('Plate photo')).toBeDisabled();
  await expect(quickLog.getByLabel('Label photo')).toBeDisabled();

  await typeBarcode(page, NOT_IN_LIBRARY);
  await expect(page.getByLabel('Photograph the label')).toBeDisabled();
  await expect(page.getByText(UNREACHABLE)).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`photographs AI quick log in ${colorScheme}`, () => {
    test.use({ colorScheme });

    test.describe(() => {
      test.use({ serviceWorkers: 'block' });

      test('the entry and the review', async ({ page }) => {
        await answerFromFixtures(page);
        await page.goto('/');
        await tab(page, 'Add').click();
        await page.getByLabel('Describe what you ate').fill(BREAKFAST);
        await page.screenshot({ path: join(dir, `ai-entry-${colorScheme}.png`), animations: 'disabled' });

        await page.getByRole('button', { name: 'Log with AI' }).click();
        const review = page.getByRole('dialog', { name: 'AI quick log' });
        await expect(review.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toHaveCount(4);
        await page.screenshot({ path: join(dir, `ai-review-${colorScheme}.png`), animations: 'disabled' });
      });
    });

    test('AI off while offline', async ({ page, context }) => {
      await offlineAdd(page, context);
      await page.screenshot({ path: join(dir, `ai-offline-${colorScheme}.png`), animations: 'disabled' });
    });
  });
}
