/**
 * How long a tap takes to open Progress, the list of lifts and a five-year lift sheet, on a
 * production build with invented data. Named to sort after every other spec, because each new
 * phone pulls everything already on the server.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { addDays, mondayOf, type LocalDate } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Lift } from '../src/domain/lifts.js';
import { dayKey, lb, lift, liftsBlock, ms, newSessionId, performance as performanceOf, program, slot, target } from '../test/training.fixtures.js';
import { countOnPhone, seed, stored, tab } from './app.js';

const YEARS = 5;
const RECENT_WEEKS = 12;
const WEEKS = YEARS * 52;
const SESSIONS_A_WEEK = 5;
const EXERCISES_A_SESSION = 8;
const KEY_LIFTS = 8;
const WARM_RUNS = 25;
const COLD_RUNS = 5;
/** Done twice a week for five years, so the heaviest sheet on the phone. */
const LONGEST_LIFT = 'Charted lift 0 0';

const liftOf = (d: number, e: number) => (d === 4 && e === 0 ? 'charted-lift-0-0' : `charted-lift-${d}-${e}`);
const nameOf = (d: number, e: number) => (d === 4 && e === 0 ? LONGEST_LIFT : `Charted lift ${d} ${e}`);

function catalog(): Lift[] {
  const lifts = Array.from({ length: SESSIONS_A_WEEK }, (_, d) => Array.from({ length: EXERCISES_A_SESSION }, (_, e) => ({ id: lift(liftOf(d, e)), name: nameOf(d, e), aliases: [] }))).flat();
  const unique = [...new Map(lifts.map((one) => [one.id, one])).values()];
  return unique.map((one, i) => (i < KEY_LIFTS ? { ...one, key: true } : one));
}

/** A version of the size the design measures, 25 to 30 KB, so the read is not flattered by a tiny plan. */
function versionOf(monday: LocalDate) {
  const words = 'Invented text of the length a real program carries in its cues, notes and standing rules. ';
  const days = Array.from({ length: SESSIONS_A_WEEK }, (_, d) => ({
    key: dayKey(`timed-${d}`),
    label: `Timed day ${d + 1}`,
    weekday: d + 1,
    blocks: [liftsBlock('main', Array.from({ length: EXERCISES_A_SESSION }, (_, e) => slot(`s${e}`, liftOf(d, e), 3, { label: nameOf(d, e), target: target(3, 8, 12), cue: 'Invented cue of an ordinary length, about one sentence long.' })))],
  }));
  return program(monday, days, {
    weeklyMinimum: 3,
    publishedAt: ms(new Date(`${addDays(monday, -1)}T07:02:00`).getTime()),
    lifts: catalog(),
    report: { text: words.repeat(25) },
    standing: ['rules', 'phases', 'sources'].map((key) => ({ key, title: key, text: words.repeat(40) })),
  });
}

function weekOfDocs(monday: LocalDate, w: number): readonly Mutation[] {
  return Array.from({ length: SESSIONS_A_WEEK }, (_, d) => d).flatMap((d): readonly Mutation[] => {
    const date = addDays(monday, d);
    const sessionId = newSessionId();
    const session: Mutation = { op: 'put', kind: 'session', doc: { id: sessionId, date, day: { key: dayKey(`timed-${d}`), label: `Timed day ${d + 1}` }, source: 'notion' } };
    const performances = Array.from({ length: EXERCISES_A_SESSION }, (_, e) => e).map(
      (e): Mutation => ({
        op: 'put',
        kind: 'performance',
        doc: performanceOf({ session: sessionId, date, slot: `s${e}`, lift: liftOf(d, e), label: nameOf(d, e), target: target(3, 8, 12), sets: [lb(100 + w / 4, 10), lb(100 + w / 4, 9), lb(100 + w / 4, 8)] }),
      }),
    );
    return [session, ...performances];
  });
}

interface Tap {
  /** From the tap's own event time: the sheet in the DOM, then its content in the DOM. */
  readonly sheetMs: number;
  readonly contentMs: number;
  /** The second frame after the content arrived, by which the first has painted it. */
  readonly paintedMs: number;
}

/** Times one real tap in the page, so Playwright's round trip stays out of it. */
async function timedTap(page: Page, target: ReturnType<Page['getByRole']>, sheet: string, content: string): Promise<Tap> {
  const armed = await page.evaluateHandle(
    ([sheetSelector, contentSelector]) => {
      let tappedAt: number | null = null;
      const noteTap = (event: Event) => {
        tappedAt ??= event.timeStamp;
      };
      for (const type of ['touchstart', 'pointerdown', 'mousedown', 'click']) document.addEventListener(type, noteTap, { capture: true, once: true });
      const done = new Promise<Tap>((resolve) => {
        let sheetAt: number | null = null;
        const look = () => {
          if (tappedAt === null || sheetSelector === undefined || contentSelector === undefined) return;
          sheetAt ??= document.querySelector(sheetSelector) === null ? null : performance.now();
          if (document.querySelector(contentSelector) === null || sheetAt === null) return;
          observer.disconnect();
          const contentAt = performance.now();
          const start = tappedAt;
          const shownSheet = sheetAt;
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ sheetMs: shownSheet - start, contentMs: contentAt - start, paintedMs: performance.now() - start })));
        };
        const observer = new MutationObserver(look);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      return { done };
    },
    [sheet, content] as const,
  );
  await target.tap();
  return armed.evaluate((handle) => handle.done);
}

function summary(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { runs: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? NaN, min: sorted[0] ?? NaN, max: sorted.at(-1) ?? NaN };
}
const marks = (taps: readonly Tap[]) => ({ painted: summary(taps.map((t) => t.paintedMs)), content: summary(taps.map((t) => t.contentMs)), sheet: summary(taps.map((t) => t.sheetMs)) });

const PROGRESS_SHEET = '[role="dialog"][aria-label="Progress"]';
const PROGRESS_CONTENT = `${PROGRESS_SHEET} [data-testid="board"] .row`;
const LIFT_SHEET = `[role="dialog"][aria-label="${LONGEST_LIFT}"]`;
const LIFT_CONTENT = `${LIFT_SHEET} [data-testid="lift-chart"]`;
const LIST_SHEET = '[role="dialog"][aria-label="All lifts"]';
const LIST_CONTENT = `${LIST_SHEET} ul[aria-label="Every lift"] li`;

const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const close = async (page: Page, name: string) => {
  await dialog(page, name).getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page, name)).toBeHidden();
};
const chip = (page: Page) => page.getByRole('button', { name: 'Progress', exact: true });
const longestRow = (page: Page) => dialog(page, 'Progress').getByTestId('board').getByRole('button', { name: new RegExp(`^${LONGEST_LIFT}`) });

const openProgress = (page: Page) => timedTap(page, chip(page), PROGRESS_SHEET, PROGRESS_CONTENT);
const openLift = (page: Page) => timedTap(page, longestRow(page), LIFT_SHEET, LIFT_CONTENT);
const openList = (page: Page) => timedTap(page, dialog(page, 'Progress').getByRole('button', { name: 'All lifts' }), LIST_SHEET, LIST_CONTENT);

/** Every interaction, in rotation, so warm-up and drift favor none of them. */
async function warmRuns(page: Page, runs: number) {
  const progress: Tap[] = [];
  const lifted: Tap[] = [];
  const listed: Tap[] = [];
  for (let i = 0; i < runs; i++) {
    progress.push(await openProgress(page));
    lifted.push(await openLift(page));
    await close(page, LONGEST_LIFT);
    listed.push(await openList(page));
    await close(page, 'All lifts');
    await close(page, 'Progress');
  }
  return { progress: marks(progress), lift: marks(lifted), list: marks(listed) };
}

async function toTrain(page: Page) {
  await page.reload();
  await expect(tab(page, 'Train')).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  await tab(page, 'Train').click();
  await expect(chip(page)).toBeVisible();
}

declare global {
  interface Window {
    idbReads?: { name: string; at: number; done: number; rows: number }[];
  }
}

async function readsDuring(page: Page, open: () => Promise<Tap>) {
  await page.evaluate(() => {
    window.idbReads?.splice(0);
  });
  const tap = await open();
  const reads = await page.evaluate(() => window.idbReads ?? []);
  const firstAt = Math.min(...reads.map((read) => read.at));
  const lastDone = Math.max(...reads.map((read) => read.done));
  return { requests: reads.length, rows: reads.reduce((sum, read) => sum + read.rows, 0), storageSpanMs: lastDone - firstAt, contentMs: tap.contentMs, paintedMs: tap.paintedMs };
}

test('reports the time from a tap to Progress, the list of lifts and a five-year lift sheet', async ({ page, request }) => {
  test.setTimeout(420_000);
  const today = localDate();
  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: WEEKS }, (_, w) => w);
  const docs = weeks.map((w) => weekOfDocs(addDays(thisWeek, -7 * (WEEKS - w)), w));
  const recent = docs.slice(-RECENT_WEEKS).flat();
  const older = docs.slice(0, -RECENT_WEEKS).flat();

  const inBatches = async (docs: readonly Mutation[]) => {
    for (let i = 0; i < docs.length; i += 400) await seed(request, docs.slice(i, i + 400));
  };
  await inBatches([{ op: 'put', kind: 'program', doc: versionOf(thisWeek) }, ...recent]);
  await page.goto('/');
  await expect.poll(() => countOnPhone(page, 'performance'), { timeout: 60_000 }).toBeGreaterThanOrEqual(recent.filter((m) => m.kind === 'performance').length);
  await toTrain(page);
  const twelveWeeks = await warmRuns(page, WARM_RUNS);

  await inBatches(older);
  // Every row the server holds, because a pull still running would re-run each read it timed.
  const allRows = stored('performance');
  await page.reload();
  await expect.poll(() => countOnPhone(page, 'performance'), { timeout: 240_000 }).toBeGreaterThanOrEqual(allRows.length);
  const held = { performance: await countOnPhone(page, 'performance'), session: await countOnPhone(page, 'session'), program: await countOnPhone(page, 'program') };

  const coldProgress: Tap[] = [];
  const coldLift: Tap[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    await toTrain(page);
    coldProgress.push(await openProgress(page));
    await close(page, 'Progress');
    await toTrain(page);
    await chip(page).tap();
    await expect(longestRow(page)).toBeVisible();
    coldLift.push(await openLift(page));
  }
  await toTrain(page);
  const fiveYears = await warmRuns(page, WARM_RUNS);

  // Counted in a run not reported as a time, because the watching costs a little itself.
  await page.addInitScript({ path: join('e2e', 'watch-indexeddb.js') });
  await toTrain(page);
  const progressReads = await readsDuring(page, () => openProgress(page));
  const liftReads = await readsDuring(page, () => openLift(page));
  await close(page, LONGEST_LIFT);
  const listReads = await readsDuring(page, () => openList(page));
  await close(page, 'All lifts');

  const lifts = new Set(allRows.map((row) => row.liftId)).size;
  const longestLiftRows = WEEKS * 2;
  const report = {
    data: { ...held, lifts, years: YEARS, today, longestLiftRows },
    twelveWeeksHeld: twelveWeeks,
    fiveYearsWarm: fiveYears,
    fiveYearsAfterReload: { progress: marks(coldProgress), lift: marks(coldLift) },
    reads: { progress: progressReads, lift: liftReads, list: listReads },
  };
  const dir = join('test-results', 'timing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'progress.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`progress timing ${JSON.stringify(report)}\n`);

  expect(liftReads.rows, 'the sheet really read five years of its lift').toBeGreaterThanOrEqual(longestLiftRows);
  expect(fiveYears.progress.painted.median, 'a ceiling far above the measured number, to catch a table scan coming back').toBeLessThan(500);
  expect(fiveYears.lift.painted.median, 'the same ceiling on a lift sheet').toBeLessThan(500);
  expect(progressReads.rows, 'Progress reads twelve weeks, not the history').toBeLessThan(held.performance / 5);
  expect(listReads.rows, 'the list seeks once per lift, plus the version, and scans nothing').toBe(lifts + 1);
});
