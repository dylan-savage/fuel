/**
 * The read-only Train tab on a production build. Each test keeps to its own invented week, far
 * from today and from each other, because every spec shares one server.
 */
import { expect, test, type Page } from '@playwright/test';
import type { Mutation } from '../src/domain/kinds.js';
import type { Performance, Target } from '../src/domain/lifts.js';
import type { Block, Program } from '../src/domain/program.js';
import type { Session } from '../src/domain/session.js';
import { SyncResponse } from '../src/protocol.js';
import { cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, target } from '../test/training.fixtures.js';
import { countOnPhone, openControlled, seed, tab } from './app.js';

const DAY_MS = 86_400_000;
const at = (date: string, time = '12:00:00') => new Date(`${date}T${time}`);

function put(docs: { readonly performances?: readonly Performance[]; readonly sessions?: readonly Session[]; readonly programs?: readonly Program[] }): Mutation[] {
  return [
    ...(docs.performances ?? []).map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
    ...(docs.sessions ?? []).map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...(docs.programs ?? []).map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
  ];
}

const title = (page: Page, name: string) => page.getByRole('heading', { name, exact: true, level: 1 });
const dayRow = (page: Page, name: string | RegExp) => page.getByRole('list', { name: 'Days' }).getByRole('button', { name });

async function openDay(page: Page, name: string) {
  await dayRow(page, new RegExp(`^${name}`)).click();
  await expect(title(page, name)).toBeVisible();
  return page.locator('.train');
}

const closeDay = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();

async function openCoach(page: Page) {
  await page.getByRole('button', { name: /^Coach/ }).click();
  return page.getByRole('dialog', { name: 'Coach' });
}

const closeCoach = (page: Page) => page.getByRole('dialog', { name: 'Coach' }).getByRole('button', { name: 'Done' }).click();

test('says so in one sentence before any program exists', async ({ page }) => {
  await page.clock.install({ time: at('2020-01-08') });
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(title(page, 'Week of Jan 6')).toBeVisible();
  await expect(page.getByText('There is no program yet.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Days' })).toHaveCount(0);
});

test('a fake clock crosses two Mondays offline with no writes', async ({ page, context, request }) => {
  const first = '2031-03-03';
  const second = '2031-03-10';
  const press = liftsBlock('main', [slot('a1', 'landmine-press', 3, { label: 'Landmine press', target: target(3, 8, 12) })]);
  const one = (...blocks: readonly Block[]) => ({ key: 'one', label: 'Strength one', weekday: 1, minutes: 50, blocks: [press, ...blocks] });
  const two = { key: 'two', label: 'Strength two', weekday: 4, minutes: 45, blocks: [liftsBlock('main', [slot('b1', 'zercher-squat', 3, { label: 'Zercher squat' })])] };
  const before = program('2031-02-24', [one(), two]);
  const version = program(first, [one(checklist('retest-one', { title: 'Retest one', onlyWeek: day(first), items: ['Timed carry'] }), checklist('retest-two', { title: 'Retest two', onlyWeek: day(second), items: ['Broad jump'] })), two], {
    weeklyMinimum: 1,
    report: { text: 'Invented report for the first week.' },
    publishedAt: ms(at('2031-03-02', '07:02:00').getTime()),
    notes: [{ text: 'Every week.' }, { text: 'First week only.', onlyWeek: day(first) }, { text: 'Second week only.', onlyWeek: day(second) }],
  });
  const trained = session({ date: day(first), day: { key: dayKey('one'), label: 'Strength one' }, finishedAt: minutes(60), programId: version.id });
  const set = performance({ session: trained.id, date: first, slot: 'a1', lift: 'landmine-press', sets: [lb(40, 10), lb(40, 10), lb(40, 9)], target: target(3, 8, 12) });
  await seed(request, put({ performances: [set], sessions: [trained], programs: [before, version] }));

  await page.clock.install({ time: at('2031-03-05') });
  await openControlled(page);
  await tab(page, 'Train').click();
  await expect(page.getByTestId('week-count')).toHaveText('1 of 2 done');
  await context.setOffline(true);
  await page.reload();
  await tab(page, 'Train').click();

  const lastLine = '40 lb × 10/10/9 · Mar 3';
  await expect(title(page, 'Week of Mar 3')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Coach/ }), 'one line of the report on the row').toContainText('Invented report for the first week.');
  let coach = await openCoach(page);
  await expect(coach).toContainText(/Sunday 7:02\sAM/);
  await expect(coach.getByText('Invented report for the first week.')).toBeVisible();
  await expect(coach.getByRole('list', { name: 'Changes' }).getByRole('listitem'), 'two blocks and the minimum, with the notes left out').toHaveCount(3);
  await expect(coach.getByText('A new note on the week'), 'week notes rotate, so they are not changes').toHaveCount(0);
  await expect(coach.getByText('First week only.')).toBeVisible();
  await expect(coach.getByText('Second week only.')).toBeHidden();
  await closeCoach(page);
  await expect(dayRow(page, /^Strength one/)).toContainText('Done Mon');
  let sheet = await openDay(page, 'Strength one');
  await expect(sheet.getByText('Retest one')).toBeVisible();
  await expect(sheet.getByText('Retest two')).toBeHidden();
  await expect(sheet.getByText(lastLine)).toBeVisible();
  await closeDay(page);

  await page.clock.fastForward(7 * DAY_MS);
  await expect(title(page, 'Week of Mar 10')).toBeVisible();
  await expect(page.getByTestId('week-count')).toHaveText('0 of 2 done');
  coach = await openCoach(page);
  await expect(coach.getByText('No check-in this week')).toBeVisible();
  await expect(coach.getByText('Invented report for the first week.')).toBeHidden();
  await expect(coach.getByText('First week only.')).toBeHidden();
  await expect(coach.getByText('Second week only.')).toBeVisible();
  await expect(coach.getByText('Every week.')).toBeVisible();
  await closeCoach(page);
  await expect(dayRow(page, /^Strength one/), 'undone again').not.toContainText('Done');
  sheet = await openDay(page, 'Strength one');
  await expect(sheet.getByText('Retest one')).toBeHidden();
  await expect(sheet.getByText('Retest two')).toBeVisible();
  await expect(sheet.getByText(lastLine)).toBeVisible();
  await closeDay(page);

  await page.clock.fastForward(7 * DAY_MS);
  await expect(title(page, 'Week of Mar 17')).toBeVisible();
  coach = await openCoach(page);
  await expect(coach.getByText('No check-in this week')).toBeVisible();
  await expect(coach.getByText('Second week only.')).toBeHidden();
  await closeCoach(page);
  sheet = await openDay(page, 'Strength one');
  await expect(sheet.getByText('Retest two')).toBeHidden();
  await expect(sheet.getByText(lastLine)).toBeVisible();
  await closeDay(page);

  await page.reload();
  await tab(page, 'Train').click();
  await expect(title(page, 'Week of Mar 17')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Coach', exact: true }), 'a quiet week leaves the row its name').toBeVisible();

  expect(await countOnPhone(page, 'outbox'), 'nothing was written').toBe(0);
  await expect(page.getByText(/\d+ waiting/)).toBeHidden();
});

test('shows the week and a day as approved, from imports, a mid-week version and sets as typed', async ({ page, request }) => {
  const MONDAY = '2031-06-02';
  const fly = slot('p1', 'cable-fly', 3, { label: 'Cable fly', target: target(3, 8, 12), cue: 'Invented cue about tempo.', swaps: [{ liftId: lift('pec-deck'), label: 'Pec deck' }] });
  const row = slot('p2', 'meadows-row', 3, { label: 'Meadows row', target: target(3, 8, 12, { perSide: 'left-first' }) });
  const pressDay = (heavy: Target) => ({
    key: 'press',
    label: 'Press day',
    weekday: 1,
    minutes: 55,
    blocks: [
      liftsBlock('extras', [slot('e1', 'reverse-crunch', 2, { label: 'Reverse crunch', target: target(2, 15, 15, { load: 'bodyweight' }) })], { title: 'Extras', optional: true }),
      checklist('warm', { title: 'Warm up', note: 'Invented note on warming up.', items: ['Band pull-apart', 'Easy row'] }),
      liftsBlock('pair', [fly, row], { restSeconds: 75 }),
      liftsBlock('heavy', [slot('d1', 'trap-bar-deadlift', 3, { label: 'Trap bar deadlift', target: heavy })], { title: 'Heavy', restSeconds: 120 }),
      cardio('ride', { title: 'Easy ride' }),
      checklist('gone', { title: 'Lapsed block', onlyWeek: day('2031-05-26') }),
    ],
  });
  const pullDay = { key: 'pull', label: 'Pull day', weekday: 2, minutes: 50, blocks: [liftsBlock('main', [slot('l1', 'pendlay-row', 3, { label: 'Pendlay row' })])] };
  const laterDays = [
    { key: 'legs', label: 'Leg day', weekday: 4, minutes: 60, blocks: [liftsBlock('main', [slot('q1', 'front-squat', 3, { label: 'Front squat' })])] },
    { key: 'upper', label: 'Upper day', weekday: 5, blocks: [liftsBlock('main', [slot('u1', 'pin-press', 3, { label: 'Pin press' })])] },
  ];
  const catalog = [
    { id: lift('cable-fly'), name: 'Cable fly', aliases: [] },
    { id: lift('pec-deck'), name: 'Pec deck', aliases: [] },
    { id: lift('meadows-row'), name: 'Meadows row', aliases: [] },
    { id: lift('trap-bar-deadlift'), name: 'Trap bar deadlift', aliases: [lift('hex-bar-deadlift')] },
    { id: lift('reverse-crunch'), name: 'Reverse crunch', aliases: [] },
    { id: lift('pendlay-row'), name: 'Pendlay row', aliases: [] },
    { id: lift('front-squat'), name: 'Front squat', aliases: [] },
    { id: lift('pin-press'), name: 'Pin press', aliases: [] },
  ];
  const longNote = `${'Invented long note about pacing the week. '.repeat(4)}The very end of the note.`;
  const before = program('2031-05-26', [pressDay(target(3, 8, 12)), pullDay, ...laterDays], { lifts: catalog, standing: [{ key: 'rules', title: 'Rules', text: 'Invented rule one.' }] });
  const inEffect = {
    lifts: catalog,
    weeklyMinimum: 2,
    notes: [{ text: longNote }, { text: 'Only on press day.', day: dayKey('press') }],
    standing: [
      { key: 'rules', title: 'Rules', text: 'Invented rule one.' },
      { key: 'plan', title: 'The long plan', text: 'Invented plan text that stays folded until tapped.' },
    ],
  };
  const monday = program(MONDAY, [pressDay(target(3, 6, 10)), pullDay, ...laterDays], {
    ...inEffect,
    report: { title: 'Week thirteen', text: 'Invented report: the week went to plan.' },
    publishedAt: ms(at('2031-06-01', '07:02:00').getTime()),
    changes: [{ target: 'prescription:press/d1', why: 'Invented reason for fewer reps.' }],
  });
  const midWeek = program('2031-06-04', [pressDay(target(3, 6, 10)), { ...pullDay, label: 'Pull day, renamed' }, ...laterDays], { ...inEffect, publishedAt: ms(at('2031-06-03', '19:00:00').getTime()) });
  const imported = session({ date: day(MONDAY), day: { key: dayKey('press'), label: 'Press day' }, source: 'notion', startedAt: undefined });
  const cardioOnly = session({ date: day('2031-06-03'), day: { key: dayKey('swim'), label: 'Swim' }, source: 'notion', startedAt: undefined, note: 'Invented swim.' });
  const pulled = session({ date: day('2031-06-04'), day: { key: dayKey('pull'), label: 'Pull day' }, programId: monday.id, finishedAt: minutes(60) });
  const logged = [
    performance({ date: '2031-05-30', lift: 'cable-fly', sets: [kg(22.5, 12), kg(22.5, 10), kg(22.5, 9)], target: target(3, 8, 12) }),
    performance({ date: '2031-05-29', lift: 'meadows-row', sets: [sides(35, 10, 9), sides(35, 9, 9)], target: target(2, 8, 12, { perSide: 'left-first' }) }),
    performance({ date: '2031-05-28', lift: 'hex-bar-deadlift', sets: [lb(225, 12), lb(225, 12), lb(225, 12)], target: target(3, 8, 12) }),
    performance({ session: pulled.id, date: '2031-06-04', slot: 'l1', lift: 'pendlay-row', sets: [lb(95, 8)] }),
  ];
  await seed(request, put({ performances: logged, sessions: [imported, cardioOnly, pulled], programs: [before, monday, midWeek] }));

  await page.clock.install({ time: at('2031-06-05') });
  await page.goto('/');
  await tab(page, 'Train').click();

  await expect(title(page, 'Week of Jun 2')).toBeVisible();
  await expect(page.getByTestId('week-count')).toHaveText('3 of 4 done', { timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'Days' }).getByRole('button'), 'every day, as equal rows in weekday order').toHaveText([/^Press day/, /^Pull day, renamed/, /^Leg day/, /^Upper day/]);
  await expect(page.locator('.train .primary'), 'no primary action, and no suggested day').toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  await expect(dayRow(page, /^Press day/), 'an imported session with no pin').toContainText('Done Mon');
  await expect(dayRow(page, /^Pull day, renamed/), 'a Tuesday plan done on Wednesday, under a version published since').toContainText('Done Wed');
  await expect(dayRow(page, /^Leg day/), 'today is Thursday and leg day is undone, and it is a row like any other').not.toContainText('Done');

  const coach = await openCoach(page);
  await expect(coach).toContainText(/Sunday 7:02\sAM/);
  await expect(coach).toContainText('Week thirteen');
  await expect(coach).toContainText('Invented report: the week went to plan.');
  await expect(coach.getByText('Press day / Trap bar deadlift went from 3 x 8-12 to 3 x 6-10')).toBeVisible();
  await expect(coach.getByText('Invented reason for fewer reps.')).toBeVisible();
  await expect(coach.getByText('Pull day is now called Pull day, renamed')).toBeVisible();
  await expect(coach.getByText('Weekly minimum is now 2')).toBeVisible();
  await expect(coach.getByText(/The very end of the note\./), 'a note in full, with no More link').toBeVisible();
  await expect(coach.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
  await expect(coach.getByText('Only on press day.')).toBeHidden();
  await closeCoach(page);

  const sheet = await openDay(page, 'Press day');
  await expect(sheet.getByText('55 min · 3 exercises')).toBeVisible();
  await expect(sheet.getByText('Only on press day.')).toBeVisible();
  await expect(sheet.getByRole('heading', { level: 3 }), 'a one-lift block has no heading').toHaveText(['Superset · 3 rounds · rest 75s']);
  await expect(sheet.getByText('Lapsed block')).toBeHidden();
  await expect(sheet.getByRole('button', { name: /^(Start|Finish)$/ })).toHaveCount(0);

  // A checklist is one row that opens.
  await expect(sheet.getByText('Warm up · 2 moves')).toBeVisible();
  await expect(sheet.getByText('Band pull-apart')).toBeHidden();
  await sheet.getByText('Warm up · 2 moves').click();
  await expect(sheet.getByText('Invented note on warming up.')).toBeVisible();
  await expect(sheet.getByText('Band pull-apart')).toBeVisible();

  // A row shows the name, the target, its dots and last time, and opens the exercise.
  const pair = sheet.getByRole('region', { name: /^Superset/ });
  const flyRow = pair.getByRole('button', { name: /^Cable fly/ });
  await expect(flyRow.locator('.row-end')).toContainText('3 × 8–12');
  await expect(flyRow).toHaveAccessibleName(/0 of 3 logged/);
  await expect(pair.getByText('22.5 kg × 12/10/9 · May 30'), 'a kg set as typed').toBeVisible();
  await expect(pair.getByText('35 lb × 10+9/9+9 · May 29'), 'a per-side set as typed').toBeVisible();

  // Its words wait behind Cue on the exercise.
  await flyRow.click();
  await page.getByRole('button', { name: 'Cue', exact: true }).click();
  const cue = page.getByRole('dialog', { name: 'Cue' });
  await expect(cue.getByText('Invented cue about tempo.')).toBeVisible();
  await expect(cue.getByText('Rest 75s'), 'rest as plain text').toBeVisible();
  await cue.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Pec deck' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Swap' }).getByRole('button', { name: 'Cancel' }).click();
  await closeDay(page);

  const heavy = sheet.getByRole('button', { name: /^Trap bar deadlift/ });
  await expect(heavy.getByText('225 lb × 12/12/12 · May 28'), 'a lift logged under an alias').toBeVisible();
  await expect(heavy.locator('.row-end')).toContainText('3 × 6–10');
  await expect(sheet.getByText('Add weight'), 'the mark waits on the exercise').toBeHidden();
  await heavy.click();
  await expect(page.getByRole('region', { name: 'Set', exact: true }).getByText('Add weight')).toBeVisible();
  await page.getByRole('button', { name: 'Cue', exact: true }).click();
  await expect(cue.getByText('Rest 120s')).toBeVisible();
  await expect(cue.getByText('Heavy', { exact: true })).toBeVisible();
  await cue.getByRole('button', { name: 'Done' }).click();
  await closeDay(page);

  // Optional blocks fold into one row at the end.
  const optional = sheet.getByRole('region', { name: 'Optional' });
  await expect(optional.locator('.row-detail').first()).toHaveText('Reverse crunch');
  await expect(optional.getByText('2 × 15')).toBeHidden();
  await optional.getByText('Optional', { exact: true }).click();
  await expect(optional.getByText('2 × 15')).toBeVisible();
  await expect(sheet.locator('> section').last(), 'at the end').toHaveAccessibleName('Optional');

  await closeDay(page);

  await page.getByRole('button', { name: 'Program', exact: true }).click();
  const standing = page.getByRole('dialog', { name: 'Program' });
  await expect(standing.getByText('Invented plan text that stays folded until tapped.')).toBeHidden();
  await standing.getByText('The long plan').click();
  await expect(standing.getByText('Invented plan text that stays folded until tapped.')).toBeVisible();
  await standing.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Weigh in', exact: true }).click();
  const entry = page.getByRole('dialog', { name: 'Weigh-in' });
  await entry.getByLabel('Weight').fill('181.2');
  await entry.getByRole('button', { name: 'Save weigh-in' }).click();
  await expect(entry).toBeHidden();
  await expect(page.getByRole('button', { name: 'Weigh in', exact: true })).toBeHidden();
});

test.describe('a shell that has just updated', () => {
  // page.route cannot see what a service worker answers, and a new build here is the page's own script rewritten on its way in.
  test.use({ serviceWorkers: 'block' });

  test('renders what it holds at each step of a re-pull and ends on the whole week', async ({ page, request }) => {
    const trouble: string[] = [];
    page.on('pageerror', (err) => trouble.push(err.message));
    page.on('console', (message) => {
      if (message.type() === 'error') trouble.push(message.text());
    });

    const MONDAY = '2031-09-01';
    const lifting = [liftsBlock('main', [slot('a1', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) })])];
    const earlier = program('2031-08-25', [{ key: 'push', label: 'Older push', weekday: 1, blocks: lifting }]);
    const current = program(MONDAY, [{ key: 'push', label: 'Newer push', weekday: 1, blocks: lifting }, { key: 'pull', label: 'New pull', weekday: 4, blocks: lifting }], { report: { text: 'Invented report past the re-pull.' } });
    const trained = session({ date: day(MONDAY), day: { key: dayKey('push'), label: 'Older push' }, finishedAt: minutes(60), programId: earlier.id });
    const set = performance({ date: '2031-08-28', lift: 'seal-row', sets: [lb(70, 9)], target: target(3, 8, 12) });
    await seed(request, put({ performances: [set], sessions: [trained], programs: [earlier, current] }));

    type Phase = 'older shell' | 'first round' | 'held' | 'open';
    let phase: Phase = 'older shell';
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/sync', async (route) => {
      if (phase === 'held') await released;
      const body = SyncResponse.parse(await (await route.fetch()).json());
      if (phase === 'older shell') return route.fulfill({ json: { ...body, changes: body.changes.map((c) => (c.kind === 'program' ? { ...c, kind: 'futureKind' } : c)) } });
      const newest = body.changes.find((c) => c.id === current.id);
      if (phase === 'first round' && newest !== undefined) {
        phase = 'held';
        return route.fulfill({ json: { ...body, changes: body.changes.filter((c) => c.rev < newest.rev), cursor: newest.rev - 1, more: true } });
      }
      return route.fulfill({ json: body });
    });

    await page.clock.install({ time: at('2031-09-03') });
    await page.goto('/');
    await tab(page, 'Train').click();
    await expect(title(page, 'Week of Sep 1')).toBeVisible();
    await expect(page.getByText('There is no program yet.')).toBeVisible();

    await tab(page, 'Goal').click();
    const build = (await page.getByTestId('build').textContent())?.replace('Build ', '') ?? '';
    expect(build).toMatch(/^[0-9a-f]{7,}$/);
    await page.route('**/assets/*.js', async (route) => {
      const script = await (await route.fetch()).text();
      return route.fulfill({ contentType: 'text/javascript', body: script.replaceAll(build, `${build}-next`) });
    });

    phase = 'first round';
    await page.reload();
    await tab(page, 'Train').click();
    await expect(dayRow(page, /^Older push/), 'the older version in effect, its session marked by key').toContainText('Done Mon', { timeout: 15_000 });
    await expect(page.getByTestId('week-count')).toHaveText('1 of 1 done');
    await expect(page.getByRole('button', { name: 'Coach', exact: true })).toBeVisible();

    phase = 'open';
    release();
    await expect(dayRow(page, /^Newer push/), 'the rest arrives with no tap').toContainText('Done Mon', { timeout: 15_000 });
    await expect(page.getByTestId('week-count')).toHaveText('1 of 2 done');
    await expect(page.getByRole('button', { name: /^Coach/ })).toContainText('Invented report past the re-pull.');
    const coach = await openCoach(page);
    await expect(coach.getByRole('heading', { name: 'What changed' })).toBeVisible();
    await closeCoach(page);
    const sheet = await openDay(page, 'New pull');
    await expect(sheet.getByText('70 lb × 9 · Aug 28')).toBeVisible();
    expect(trouble).toEqual([]);
  });
});
