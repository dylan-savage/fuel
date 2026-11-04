/**
 * How long a tap on Train takes to show the day list, on a production build with invented data of
 * realistic size. Named to sort after every other spec, because all of them share one server and
 * each new phone pulls everything already on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { addDays, mondayOf } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import { dayKey, lb, liftsBlock, ms, newSessionId, performance as performanceOf, program, slot, target } from '../test/training.fixtures.js';
import { countOnPhone, seed, stored, tab } from './app.js';

const YEARS = 3;
const RECENT_WEEKS = 6;
const WEEKS = YEARS * 52 + RECENT_WEEKS;
const SESSIONS_A_WEEK = 5;
const EXERCISES_A_SESSION = 8;
const COLD_RUNS = 5;
const WARM_RUNS = 25;

/** A version as the design measures one, 25 to 30 KB, so the read is not flattered by a tiny plan. */
function versionOf(monday: ReturnType<typeof mondayOf>, days: Parameters<typeof program>[1]) {
  const words = 'Invented text of the length a real program carries in its cues, notes and standing rules. ';
  return program(monday, days, {
    weeklyMinimum: 3,
    publishedAt: ms(new Date(`${addDays(monday, -1)}T07:02:00`).getTime()),
    report: { text: words.repeat(25) },
    notes: [{ text: words.repeat(4) }],
    standing: ['rules', 'phases', 'sources'].map((key) => ({ key, title: key, text: words.repeat(40) })),
  });
}

function planned() {
  const slots = Array.from({ length: SESSIONS_A_WEEK }, (_, d) =>
    Array.from({ length: EXERCISES_A_SESSION }, (_, e) => slot(`s${e}`, `timed-lift-${d}-${e}`, 3, { label: `Timed lift ${d} ${e}`, target: target(3, 8, 12), cue: 'Invented cue of an ordinary length, about one sentence long.' })),
  );
  const days = slots.map((daySlots, d) => ({ key: dayKey(`timed-${d}`), label: `Timed day ${d + 1}`, weekday: d + 1, minutes: 55, blocks: [liftsBlock('main', daySlots.slice(0, 2), { restSeconds: 75 }), ...daySlots.slice(2).map((one, e) => liftsBlock(`b${e}`, [one], { restSeconds: 120 }))] }));
  return { days, slots };
}

/** Once per run, so both tests hold the same documents and seeding twice writes nothing new. */
function historyOf(today: ReturnType<typeof localDate>) {
  cachedHistory ??= history(today);
  return cachedHistory;
}
let cachedHistory: ReturnType<typeof history> | undefined;

function history(today: ReturnType<typeof localDate>) {
  const thisWeek = mondayOf(today);
  const { days, slots } = planned();
  const versions = Array.from({ length: RECENT_WEEKS }, (_, i) => versionOf(addDays(thisWeek, -7 * (RECENT_WEEKS - 1 - i)), days));
  const docs = Array.from({ length: WEEKS }, (_, w) => w).flatMap((w): readonly Mutation[] => {
    const monday = addDays(thisWeek, -7 * (WEEKS - w));
    return Array.from({ length: SESSIONS_A_WEEK }, (_, d) => d).flatMap((d): readonly Mutation[] => {
      const date = addDays(monday, d);
      const sessionId = newSessionId();
      const session: Mutation = { op: 'put', kind: 'session', doc: { id: sessionId, date, day: { key: dayKey(`timed-${d}`), label: `Timed day ${d + 1}` }, source: 'notion' } };
      const performances = (slots[d] ?? []).map(
        (one): Mutation => ({ op: 'put', kind: 'performance', doc: performanceOf({ session: sessionId, date, slot: one.id, lift: one.liftId, label: one.label, target: one.target, sets: [lb(100 + w, 10), lb(100 + w, 9), lb(100 + w, 8)] }) }),
      );
      return [session, ...performances];
    });
  });
  return { versions, docs };
}

interface Tap {
  /** From the tap's own event time: the title in the DOM, then the list in the DOM. */
  readonly titleMs: number;
  readonly listMs: number;
  /** The second frame after the list arrived, by which the first has painted it. */
  readonly paintedMs: number;
  readonly rows: number;
}

/** Times one real tap in the page, so Playwright's round trip stays out of it. */
async function tapTrain(page: Page): Promise<Tap> {
  const armed = await page.evaluateHandle(() => {
    let tappedAt: number | null = null;
    const noteTap = (event: Event) => {
      tappedAt ??= event.timeStamp;
    };
    for (const type of ['touchstart', 'pointerdown', 'mousedown', 'click']) document.addEventListener(type, noteTap, { capture: true, once: true });
    const done = new Promise<{ titleMs: number; listMs: number; paintedMs: number; rows: number }>((resolve) => {
      let titleAt: number | null = null;
      const look = () => {
        if (tappedAt === null) return;
        titleAt ??= document.querySelector('.train h1') === null ? null : performance.now();
        const list = document.querySelector('ul[aria-label="Days"]');
        if (list === null || titleAt === null) return;
        observer.disconnect();
        const listAt = performance.now();
        const rows = list.children.length;
        const start = tappedAt;
        const shownTitle = titleAt;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ titleMs: shownTitle - start, listMs: listAt - start, paintedMs: performance.now() - start, rows })));
      };
      const observer = new MutationObserver(look);
      observer.observe(document.body, { subtree: true, childList: true });
    });
    return { done };
  });
  await tab(page, 'Train').tap();
  return armed.evaluate((handle) => handle.done);
}

function summary(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { runs: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? NaN, min: sorted[0] ?? NaN, max: sorted.at(-1) ?? NaN };
}

test('reports the time from a tap on Train to the day list, on years of invented data', async ({ page, request }) => {
  test.setTimeout(240_000);
  const today = localDate();
  const { versions, docs } = historyOf(today);
  const versionBytes = Math.max(...versions.map((version) => JSON.stringify(version).length));
  expect(versionBytes, 'a version of realistic size').toBeGreaterThanOrEqual(25_000);
  const performances = docs.filter((m) => m.kind === 'performance').length;

  const tapsFromDiary = async () => {
    const taps: Tap[] = [];
    for (let i = 0; i < WARM_RUNS; i++) {
      await tab(page, 'Diary').click();
      await expect(page.getByRole('region', { name: 'Breakfast' })).toBeVisible();
      taps.push(await tapTrain(page));
      await expect(page.getByTestId('week-count')).toHaveText(`0 of ${SESSIONS_A_WEEK} done`);
    }
    return taps;
  };

  // A spec before this one may have left sessions this week, which would change the count.
  const left = stored('session').filter((s) => s.date >= mondayOf(today));
  await seed(request, [...left.map((s): Mutation => ({ op: 'delete', kind: 'session', id: s.id })), ...versions.map((doc): Mutation => ({ op: 'put', kind: 'program', doc }))]);
  await page.goto('/');
  await expect.poll(() => countOnPhone(page, 'program')).toBeGreaterThanOrEqual(versions.length);
  const beforeHistory = await tapsFromDiary();

  for (let i = 0; i < docs.length; i += 400) await seed(request, docs.slice(i, i + 400));
  const held = { session: stored('session').length, performance: stored('performance').length, program: stored('program').length };
  expect(held.performance).toBeGreaterThanOrEqual(performances);
  await page.reload();
  await expect.poll(() => countOnPhone(page, 'performance'), { timeout: 120_000 }).toBeGreaterThanOrEqual(performances);

  const afterReload: Tap[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    await page.reload();
    await expect(page.getByRole('region', { name: 'Breakfast' })).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    afterReload.push(await tapTrain(page));
    await expect(page.getByTestId('week-count')).toHaveText(`0 of ${SESSIONS_A_WEEK} done`);
  }
  const afterSwitch = await tapsFromDiary();

  for (const tap of [...beforeHistory, ...afterReload, ...afterSwitch]) expect(tap.rows, 'the list held every day when timed').toBe(SESSIONS_A_WEEK);
  const marks = (taps: readonly Tap[]) => ({ painted: summary(taps.map((t) => t.paintedMs)), list: summary(taps.map((t) => t.listMs)), title: summary(taps.map((t) => t.titleMs)) });
  const report = { data: { ...held, versionBytes, today }, beforeHistory: marks(beforeHistory), afterReload: marks(afterReload), afterTabSwitch: marks(afterSwitch) };
  const dir = join('test-results', 'timing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'train-tab.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`train tab timing ${JSON.stringify(report)}\n`);
  expect(report.afterTabSwitch.painted.median, 'a ceiling far above the measured number, to catch a table scan coming back').toBeLessThan(500);
});

interface LogTap {
  /** From the tap's own event time: the exercise naming its next set in the DOM, then the second frame after, by which the first has painted it. */
  readonly domMs: number;
  readonly paintedMs: number;
  readonly next: string;
}

async function tapLogSet(page: Page): Promise<LogTap> {
  const armed = await page.evaluateHandle(() => {
    let tappedAt: number | null = null;
    const noteTap = (event: Event) => {
      tappedAt ??= event.timeStamp;
    };
    for (const type of ['touchstart', 'pointerdown', 'mousedown', 'click']) document.addEventListener(type, noteTap, { capture: true, once: true });
    const onCard = () => document.querySelector('[data-testid="round"]')?.textContent ?? '';
    const before = onCard();
    const done = new Promise<LogTap>((resolve) => {
      const observer = new MutationObserver(() => {
        const next = onCard();
        if (tappedAt === null || next === before) return;
        observer.disconnect();
        const start = tappedAt;
        const domAt = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ domMs: domAt - start, paintedMs: performance.now() - start, next })));
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    return { done };
  });
  await page.getByRole('button', { name: 'Log set' }).tap();
  return armed.evaluate((handle) => handle.done);
}

const DAYS_TIMED = 2;
const SETS_AN_EXERCISE = 3;

test('reports the time from a tap on Log set to the exercise showing its next set, on years of invented data', async ({ page, request }) => {
  test.setTimeout(240_000);
  const trouble: string[] = [];
  page.on('pageerror', (err) => trouble.push(err.message));
  const today = localDate();
  const { versions, docs } = historyOf(today);
  const performances = docs.filter((m) => m.kind === 'performance').length;
  const left = stored('session').filter((s) => s.date >= mondayOf(today));
  await seed(request, [...left.map((s): Mutation => ({ op: 'delete', kind: 'session', id: s.id })), ...versions.map((doc): Mutation => ({ op: 'put', kind: 'program', doc }))]);
  if (stored('performance').length < performances) for (let i = 0; i < docs.length; i += 400) await seed(request, docs.slice(i, i + 400));

  await page.goto('/');
  await expect.poll(() => countOnPhone(page, 'performance'), { timeout: 120_000 }).toBeGreaterThanOrEqual(performances);
  const held = { session: stored('session').length, performance: stored('performance').length, program: stored('program').length };
  await page.reload();
  await tab(page, 'Train').click();

  const { days } = planned();
  const taps: LogTap[] = [];
  const timedDays = days.slice(0, DAYS_TIMED);
  for (const [d, plan] of timedDays.entries()) {
    await page.getByRole('list', { name: 'Days' }).getByRole('button', { name: new RegExp(`^${plan.label}`) }).tap();
    const slots = plan.blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots : []));
    // The plan's last exercise first, since nothing walks him through it.
    for (const one of slots.toReversed()) {
      await page.locator('.train').getByRole('button', { name: new RegExp(`^${one.label}`) }).tap();
      await expect(page.getByRole('button', { name: 'Log set' })).toBeEnabled();
      for (let set = 1; set <= SETS_AN_EXERCISE; set++) {
        const tap = await tapLogSet(page);
        expect(tap.next, 'it stayed on the exercise and moved to its next set').toBe(set === SETS_AN_EXERCISE ? 'Extra set' : `Set ${set + 1} of ${SETS_AN_EXERCISE}`);
        await expect(page.getByRole('button', { name: 'Log set' })).toBeEnabled();
        taps.push(tap);
      }
      await page.getByRole('button', { name: 'Back', exact: true }).tap();
    }
    await page.getByRole('button', { name: 'Back', exact: true }).tap();
    await expect(page.getByTestId('week-count')).toHaveText(`${d + 1} of ${SESSIONS_A_WEEK} done`);
  }

  const expectedSets = taps.length;
  await expect
    .poll(
      () =>
        stored('performance')
          .filter((p) => p.date === today && p.sets.every((set) => set.at !== undefined))
          .reduce((sum, p) => sum + p.sets.length, 0),
      { timeout: 30_000, message: 'every timed tap stored a set that reached the server' },
    )
    .toBe(expectedSets);
  expect(trouble).toEqual([]);
  const report = {
    data: { ...held, today, days: timedDays.map((plan) => plan.label) },
    runs: taps.length,
    painted: summary(taps.map((t) => t.paintedMs)),
    dom: summary(taps.map((t) => t.domMs)),
  };
  const dir = join('test-results', 'timing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log-set.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`log set timing ${JSON.stringify(report)}\n`);
  expect(report.painted.median, 'a ceiling far above the measured number, to catch a table scan coming back').toBeLessThan(500);
});
