/**
 * The Progress sheet on a production build: what each chart draws from invented data, which is
 * what a read test cannot see. It keeps to its own lifts and a week after every other spec's.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Mutation } from '../src/domain/kinds.js';
import type { Lift, SetLog } from '../src/domain/lifts.js';
import { SessionId, addDays, type LocalDate } from '../src/domain/ids.js';
import { band, bw, day, kg, lb, lift, liftsBlock, minutes, performance, program, session, slot, target, warm } from '../test/training.fixtures.js';
import { seed, tab } from './app.js';

const NOON = new Date('2032-06-09T12:00:00');
const MONDAY = day('2032-06-07');
const weeksBack = (weeks: number, weekday = 0) => String(addDays(MONDAY, weekday - 7 * weeks));

const catalog: readonly Lift[] = [
  { id: lift('box-squat'), name: 'Box squat', aliases: [lift('low-box-squat')], key: true },
  { id: lift('spec-ready-row'), name: 'Ready row', aliases: [], key: true },
  { id: lift('spec-weighted-dip'), name: 'Weighted dip', aliases: [], key: true },
  { id: lift('spec-ring-row'), name: 'Ring row', aliases: [], key: true },
  { id: lift('spec-once-press'), name: 'Once press', aliases: [], key: true },
  { id: lift('spec-never-curl'), name: 'Never curl', aliases: [], key: true },
  { id: lift('spec-stuck-pull'), name: 'Stuck pull', aliases: [], key: true },
  { id: lift('spec-half-loaded'), name: 'Half loaded', aliases: [], key: true },
  { id: lift('spec-band-walk'), name: 'Band walk', aliases: [] },
  { id: lift('spec-goblet-squat'), name: 'Goblet squat', aliases: [] },
];
const range = target(3, 8, 12);

/** Ids that do not change, so a worker restarted after a failure re-seeds the same documents and doubles nothing. */
let nextId = 0;
const fixedSessionId = () => SessionId.parse(`00000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`);
const logged = (input: Omit<Parameters<typeof performance>[0], 'session'>) => performance({ ...input, session: fixedSessionId() });
const row = (name: string, date: string, sets: readonly SetLog[], planned?: string) => logged({ lift: name, date, target: range, sets, ...(planned === undefined ? {} : { planned, label: 'Goblet squat' }) });
const done = (date: LocalDate) => session({ id: fixedSessionId(), date, finishedAt: minutes(60) });

const WEEK_COUNTS = [2, 3, 1, 2, 2, 4, 0, 2, 3, 2, 2];

const world: readonly Mutation[] = [
  ...[
    program(
      '2032-01-05',
      ['a', 'b'].map((key, i) => ({ key, weekday: i + 1, blocks: [liftsBlock('main', [slot(`${key}1`, 'box-squat', 3)])] })),
      { weeklyMinimum: 2, lifts: [...catalog] },
    ),
  ].map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
  ...[
    ...WEEK_COUNTS.flatMap((count, i) => Array.from({ length: count }, (_, s) => done(day(weeksBack(WEEK_COUNTS.length - i, s))))),
    done(MONDAY),
  ].map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
  ...[
    // Old enough to be out of the 3 month range, and the best of its whole history.
    row('box-squat', weeksBack(40), [lb(100, 10), lb(100, 10), lb(100, 10)]),
    row('low-box-squat', weeksBack(6), [kg(20, 10), kg(20, 10), kg(20, 10)]),
    row('spec-goblet-squat', weeksBack(4), [lb(30, 12)], 'box-squat'),
    row('box-squat', weeksBack(3), [lb(50, 10), lb(50, 9), lb(50, 9)]),
    row('box-squat', weeksBack(2), [lb(50, 12), lb(50, 12), lb(50, 11)]),
    row('box-squat', weeksBack(1), [warm(lb(90, 5)), lb(30, 20), lb(55, 10), lb(55, 9), lb(55, 9)]),

    row('spec-ready-row', weeksBack(2), [lb(70, 12), lb(70, 12), lb(70, 10)]),
    row('spec-ready-row', weeksBack(1), [lb(70, 12), lb(70, 14), lb(70, 12)]),

    logged({ lift: 'spec-weighted-dip', date: weeksBack(3), target: range, sets: [lb(25, 8)] }),
    logged({ lift: 'spec-weighted-dip', date: weeksBack(2), target: range, sets: [bw(10), bw(9)] }),
    logged({ lift: 'spec-weighted-dip', date: weeksBack(1), target: range, sets: [lb(30, 8)] }),

    logged({ lift: 'spec-ring-row', date: weeksBack(2), target: target(3, 8, 12, { load: 'bodyweight' }), sets: [bw(8), bw(7)] }),
    logged({ lift: 'spec-ring-row', date: weeksBack(1), target: target(3, 8, 12, { load: 'bodyweight' }), sets: [bw(11), bw(10)] }),

    row('spec-once-press', weeksBack(1), [lb(40, 10), lb(40, 9), lb(40, 9)]),

    ...[6, 5, 4, 3, 2, 1].map((w, i) => row('spec-stuck-pull', weeksBack(w), [lb(i === 0 ? 110 : 100, 8)])),

    logged({ lift: 'spec-half-loaded', date: weeksBack(2), sets: [lb(20, 10)] }),
    logged({ lift: 'spec-half-loaded', date: weeksBack(1), sets: [bw(12)] }),

    logged({ lift: 'spec-band-walk', date: weeksBack(1), target: target(2, 12, 15, { load: 'band' }), sets: [band('green', 12), band('red', 10)] }),
    logged({ lift: 'spec-uncataloged-sled', label: 'Uncataloged sled', date: weeksBack(0), sets: [lb(90, 20)] }),
  ].map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
];

/** A sheet slides in, so a position read before it lands points at the wrong place. */
async function settled(sheet: Locator) {
  await sheet.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
  return sheet;
}

async function openProgress(page: Page, request: Parameters<typeof seed>[0]) {
  await seed(request, world);
  await page.clock.setFixedTime(NOON);
  await page.goto('/');
  await tab(page, 'Train').click();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Progress' });
  await expect(sheet.getByTestId('board').getByRole('button', { name: /^Box squat/ })).toBeVisible({ timeout: 15_000 });
  return settled(sheet);
}

async function openLift(page: Page, progress: Locator, name: string) {
  await progress.getByTestId('board').getByRole('button', { name: new RegExp(`^${name}`) }).click();
  return settled(page.getByRole('dialog', { name }));
}

/** The vertices of the line, which is every date it connects. */
async function lineVertices(sheet: Locator): Promise<number> {
  const d = (await sheet.locator('.chart-trend').getAttribute('d')) ?? '';
  return (d.match(/[ML]/g) ?? []).length;
}

const dotCount = (sheet: Locator) => sheet.locator('.chart-dot').count();

test('shows twelve weeks of sessions against the minimum, labelled once, with the open week outlined', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  await expect(progress.getByTestId('show-up-count')).toHaveText('1 of 2 this week');
  await expect(progress.getByText('Dotted line is your weekly minimum')).toHaveCount(1);
  await expect(progress.locator('.chart-minimum')).toHaveCount(1);
  const total = WEEK_COUNTS.reduce((sum, n) => sum + n, 0);
  await expect(progress.locator('.show-up-block')).toHaveCount(total + 1);
  await expect(progress.locator('.show-up-block.open')).toHaveCount(1);

  const chart = await progress.locator('.show-up svg').boundingBox();
  const atColumn = async (i: number) => page.mouse.move((chart?.x ?? 0) + ((chart?.width ?? 0) * (i + 0.5)) / 12, (chart?.y ?? 0) + 10);
  await atColumn(5);
  await expect(progress.getByTestId('show-up-readout')).toHaveText('Week of Apr 26: 4 sessions');
  await atColumn(11);
  await expect(progress.getByTestId('show-up-readout')).toHaveText('This week: 1 session');
});

test('reads each key lift as a value and a change, a stuck one with its best, and says so when there is too little', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const board = progress.getByTestId('board');
  const rowOf = (name: string) => board.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(rowOf('Box squat').locator('.board-value')).toHaveText(/^73 lb[+−]\d+ lb$/);
  await expect(rowOf('Box squat').locator('.board-spark')).toBeVisible();
  await expect(rowOf('Stuck pull')).toContainText('best 5 sessions ago');
  await expect(rowOf('Ready row')).not.toContainText('sessions ago');
  await expect(rowOf('Ring row').locator('.board-value')).toHaveText('11 reps+3 reps');
  await expect(rowOf('Once press')).toContainText('1 session in 12 weeks');
  await expect(rowOf('Once press').locator('.board-spark')).toHaveCount(0);
  await expect(rowOf('Never curl')).toContainText('Nothing in 12 weeks');
  await expect(rowOf('Never curl').locator('.board-spark')).toHaveCount(0);
  await expect(board.getByRole('button', { name: /^Goblet squat/ })).toHaveCount(0);
});

test('lists every lift most recent first, searchable, and opens any of them', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  await progress.getByRole('button', { name: 'All lifts' }).click();
  const sheet = page.getByRole('dialog', { name: 'All lifts' });
  const list = sheet.getByRole('list', { name: 'Every lift' });
  await expect(list.getByRole('listitem').first()).toContainText('Uncataloged sled');
  await expect(list.getByRole('button', { name: /^Box squat/ })).toHaveCount(1);

  await sheet.getByLabel('Search lifts').fill('goblet');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: /^Goblet squat/ }).click();

  // A swap's sets land on the lift really done, with no tick there.
  const goblet = page.getByRole('dialog', { name: 'Goblet squat' });
  await expect(goblet.getByTestId('chart-readout')).toContainText('30 × 12');
  await expect(goblet.locator('.chart-swap')).toHaveCount(0);
  await goblet.getByRole('button', { name: 'Done' }).click();

  await sheet.getByLabel('Search lifts').fill('nothing like this');
  await expect(sheet.getByText('No lifts match.')).toBeVisible();
});

test('charts a lift: warm-ups out, kg on a pound axis and typed in the readout, a swap as a tick, an alias in the line, and no metric toggle', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const sheet = await openLift(page, progress, 'Box squat');

  await expect(sheet.getByTestId('lift-head')).toHaveText('73 lb est. 1RM');
  await expect(sheet.getByTestId('chart-readout')).toHaveText(/ · 30 × 20, 55 × 10, 55 × 9, 55 × 9$/);
  await expect(sheet.getByRole('radiogroup', { name: 'Chart range' }).getByRole('radio')).toHaveText(['3 months', '1 year', 'All']);
  await expect(sheet.getByRole('radio', { name: /Volume|Top/ })).toHaveCount(0);
  await expect(sheet.getByText('Top weight')).toBeVisible();
  await expect(sheet.locator('.chart-legend').getByText('Est. 1RM')).toBeVisible();

  // Four sessions of its own, one under its alias, with the swap between them a tick and no vertex.
  await expect.poll(() => lineVertices(sheet)).toBe(4);
  expect(await dotCount(sheet)).toBe(4);
  await expect(sheet.locator('.chart-swap')).toHaveCount(1);
  await expect(sheet.getByText('swapped')).toHaveCount(1);
  await expect(sheet.locator('.chart-best text')).toHaveText('Best 73');

  const firstDot = await sheet.locator('.chart-dot').first().boundingBox();
  await page.mouse.move((firstDot?.x ?? 0) + (firstDot?.width ?? 0) / 2, (firstDot?.y ?? 0) + (firstDot?.height ?? 0) / 2);
  await expect(sheet.getByTestId('chart-readout')).toContainText('20 kg × 10, 20 kg × 10, 20 kg × 10');
  await expect(sheet.getByTestId('chart-readout')).toContainText('1,323 lb volume');
  await expect(sheet.getByTestId('lift-head')).toHaveText('59 lb est. 1RM');
  await page.mouse.move(0, 0);
  await expect(sheet.getByTestId('chart-readout')).not.toContainText('volume');

  await sheet.getByRole('radio', { name: 'All' }).click();
  await expect.poll(() => lineVertices(sheet)).toBe(5);
  await expect(sheet.locator('.chart-best text')).toHaveText('Best 133');
  await expect(sheet.getByTestId('lift-head')).toHaveText('73 lb est. 1RM');
  const lbTicks = await sheet.locator('.chart-grid text').allTextContents();
  expect(lbTicks.every((tick) => Number(tick.replace(',', '')) % 10 === 0), 'the axis stays in round pounds').toBe(true);
});

test('bridges a bodyweight day with no dip, and the readout says what it was', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const sheet = await openLift(page, progress, 'Weighted dip');
  await expect.poll(() => lineVertices(sheet)).toBe(2);
  expect(await dotCount(sheet)).toBe(2);
  const [first, last] = await Promise.all([sheet.locator('.chart-dot').first().boundingBox(), sheet.locator('.chart-dot').last().boundingBox()]);
  await page.mouse.move(((first?.x ?? 0) + (last?.x ?? 0)) / 2 + 4, first?.y ?? 0);
  await expect(sheet.getByTestId('lift-head')).toHaveText('No est. 1RM');
  await expect(sheet.getByTestId('chart-readout')).toContainText('BW × 10, BW × 9');
});

test('plots best reps for a lift never loaded, with no pound axis, no legend and no bars', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const sheet = await openLift(page, progress, 'Ring row');
  await expect(sheet.getByTestId('lift-head')).toHaveText('11 reps best set');
  await expect.poll(() => lineVertices(sheet)).toBe(2);
  expect(await dotCount(sheet)).toBe(0);
  await expect(sheet.locator('.chart-legend')).toHaveCount(0);
  await expect(sheet.getByTestId('to-go-head')).toHaveCount(0);
  await expect(sheet.getByText('How close am I to adding weight?')).toHaveCount(0);
  await expect(sheet.getByRole('list', { name: 'Recent sessions' }).getByRole('listitem').first()).toHaveText(/BW\s*11, 10/);
});

test('counts the reps to added weight in bars against the top of the range, and marks where weight went up', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const sheet = await openLift(page, progress, 'Box squat');
  await expect(sheet.getByTestId('to-go-head')).toHaveText('8 reps from adding weight');
  await expect(sheet.getByTestId('to-go-sub')).toHaveText('All 3 sets at 55 lb need to reach 12');
  const sets = sheet.getByRole('list', { name: 'Sets at that load' }).getByRole('listitem');
  await expect(sets).toHaveText([/Set 1\s*10 of 12/, /Set 2\s*9 of 12/, /Set 3\s*9 of 12/]);
  const widthShare = (i: number) =>
    sets.nth(i).evaluate((el) => {
      const track = el.querySelector('.to-go-track')?.getBoundingClientRect().width ?? 0;
      return (el.querySelector('.to-go-fill')?.getBoundingClientRect().width ?? 0) / track;
    });
  expect(await widthShare(0)).toBeCloseTo(10 / 12, 2);

  const recent = sheet.getByRole('list', { name: 'Recent sessions' }).getByRole('listitem');
  await expect(recent.first()).toHaveText(/55 lb\s*10, 9, 9\s*Added 5 lb/);
  await expect(recent.nth(1)).not.toContainText('Added');
});

test('says add weight next time at the top of the range, with full bars however far past it', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const sheet = await openLift(page, progress, 'Ready row');
  await expect(sheet.getByTestId('to-go-head')).toHaveText('Add weight next time');
  await expect(sheet.locator('.to-go-check')).toBeVisible();
  await expect(sheet.getByTestId('to-go-sub')).toHaveText('All 3 sets at 70 lb reached 12');
  const fills = await sheet.locator('.to-go-sets li').evaluateAll((rows) => rows.map((el) => (el.querySelector('.to-go-fill')?.getBoundingClientRect().width ?? 0) / (el.querySelector('.to-go-track')?.getBoundingClientRect().width ?? 1)));
  expect(fills).toEqual([1, 1, 1]);
});

test('hides the bars on a band lift and keeps its recent rows', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  await progress.getByRole('button', { name: 'All lifts' }).click();
  await page.getByRole('dialog', { name: 'All lifts' }).getByRole('button', { name: /^Band walk/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Band walk' });
  await expect(sheet.getByRole('list', { name: 'Recent sessions' }).getByRole('listitem').first()).toHaveText(/green\/red\s*12, 10/);
  await expect(sheet.getByRole('list', { name: 'Sets at that load' })).toHaveCount(0);
});

test('says something plain in place of a line with one session or none, and draws no broken chart', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  const once = await openLift(page, progress, 'Once press');
  await expect(once.getByTestId('lift-head')).toHaveText('53 lb est. 1RM');
  await expect(once.getByTestId('lift-chart-empty')).toHaveText('Only one session in the last 3 months, so there is no line yet.');
  await expect(once.getByTestId('lift-chart')).toHaveCount(0);
  await expect(once.getByTestId('to-go-head')).toHaveText('8 reps from adding weight');
  await once.getByRole('radio', { name: 'All' }).click();
  await expect(once.getByTestId('lift-chart-empty')).toHaveText('Only one session so far, so there is no line yet.');
  await once.getByRole('button', { name: 'Done' }).click();

  const half = await openLift(page, progress, 'Half loaded');
  await expect(half.getByTestId('lift-head')).toHaveText('27 lb est. 1RM');
  await expect(half.getByTestId('lift-chart-empty')).toHaveText('Only one weighted session in the last 3 months, so there is no line yet.');
  await half.getByRole('button', { name: 'Done' }).click();

  const never = await openLift(page, progress, 'Never curl');
  await expect(never.getByTestId('lift-head')).toHaveText('No sessions yet');
  await expect(never.getByTestId('lift-chart')).toHaveCount(0);
  await expect(never.getByRole('radiogroup', { name: 'Chart range' })).toHaveCount(0);
  await expect(never.getByTestId('to-go-head')).toHaveCount(0);
  await expect(never.getByRole('list', { name: 'Recent sessions' })).toHaveCount(0);
});

test('comes back to Train on Done, with the chip still there', async ({ page, request }) => {
  const progress = await openProgress(page, request);
  await progress.getByRole('button', { name: 'Done' }).click();
  await expect(progress).toBeHidden();
  await expect(page.getByRole('button', { name: 'Progress', exact: true })).toBeVisible();
});
