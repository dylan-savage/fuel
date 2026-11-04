/**
 * Screenshots of the main screens on the iPhone profile, light and dark, for UI review.
 * Written to FUEL_SHOTS_DIR, else test-results/shots.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { localDate } from '../src/client/clock.js';
import { weighInId } from '../src/domain/body.js';
import { makeWorkout, metDraft } from '../src/domain/burn.js';
import { makeEntry, type Meal } from '../src/domain/diary.js';
import { snapshotOf, type Food, type Ingredient, type Serving } from '../src/domain/food.js';
import { HOUR_MS, ML_PER_FL_OZ, type Fast, type FastEnd } from '../src/domain/habits.js';
import { KG_PER_LB } from '../src/domain/goals.js';
import { EntryId, FastEndId, FastId, FoodId, Millis, RecipeId, SavedMealId, WaterId, WorkoutId, addDays, type LocalDate } from '../src/domain/ids.js';
import type { Mutation } from '../src/domain/kinds.js';
import type { Recipe, SavedMeal } from '../src/domain/reuse.js';
import { band, bw, cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, program, session, sides, slot, target, warm } from '../test/training.fixtures.js';
import { openRow, saveGoal, seed, setGoal, stored, tab, typeBarcode } from './app.js';

const dir = process.env.FUEL_SHOTS_DIR ?? join('test-results', 'shots');
/** Lay's Classic, never imported by any spec, so its barcode always reaches the confirm sheet. */
const LAYS = '028400090858';

function libraryFood(name: string, nutrients: Food['nutrients'], servings: Serving[] = []): Food {
  return { id: FoodId.parse(randomUUID()), name, unit: 'g', nutrients, servings, barcodes: [], source: { kind: 'user' }, archived: false };
}
const grams = (food: Food, amount: number): Ingredient => ({ food: snapshotOf(food), quantity: { kind: 'amount', amount } });

/** A recipe and a saved meal with their foods, so the reuse screens have something to show. */
function reuseDocs(): Mutation[] {
  const chicken = libraryFood('Chicken thigh', { kcal: 177, protein: 24, carbs: 0, fat: 8.2 });
  const rice = libraryFood('Jasmine rice, cooked', { kcal: 129, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 });
  const broccoli = libraryFood('Broccoli', { kcal: 34, protein: 2.8, carbs: 6.6, fat: 0.4, fiber: 2.6 });
  const pot: Serving = { label: '1 pot', amount: 170 };
  const yogurt = libraryFood('Greek yogurt', { kcal: 97, protein: 9, carbs: 3.6, fat: 5 }, [pot]);
  const berries = libraryFood('Blueberries', { kcal: 57, protein: 0.7, carbs: 14.5, fat: 0.3, fiber: 2.4 });
  const granola = libraryFood('Granola', { kcal: 471, protein: 10, carbs: 64, fat: 20, fiber: 5.3 });
  const bowl: Recipe = {
    id: RecipeId.parse(randomUUID()),
    name: 'Chicken rice bowl',
    ingredients: [grams(chicken, 600), grams(rice, 750), grams(broccoli, 300)],
    yield: { servings: 4, cookedGrams: 1550 },
    archived: false,
  };
  const breakfast: SavedMeal = {
    id: SavedMealId.parse(randomUUID()),
    name: 'Usual breakfast',
    items: [{ food: snapshotOf(yogurt), quantity: { kind: 'serving', serving: pot, count: 1 } }, grams(berries, 80), grams(granola, 40)],
    archived: false,
  };
  return [
    ...[chicken, rice, broccoli, yogurt, berries, granola].map((doc): Mutation => ({ op: 'put', kind: 'food', doc })),
    { op: 'put', kind: 'recipe', doc: bowl },
    { op: 'put', kind: 'savedMeal', doc: breakfast },
  ];
}

test.describe.configure({ mode: 'serial' });

/**
 * Today's drinks, a fast 13.4 hours in and a week of finished ones, replacing any fasts and
 * drinks other specs left, so the timer and history photograph the same every run.
 */
function habitDocs(): Mutation[] {
  const now = Date.now();
  const today = localDate();
  const cleared = [
    ...stored('fast').map((f): Mutation => ({ op: 'delete', kind: 'fast', id: f.id })),
    ...stored('fastEnd').map((e): Mutation => ({ op: 'delete', kind: 'fastEnd', id: e.id })),
    ...stored('water').map((w): Mutation => ({ op: 'delete', kind: 'water', id: w.id })),
  ];
  const drinks = [16, 8, 16, 12].map((oz, i): Mutation => ({
    op: 'put',
    kind: 'water',
    doc: { id: WaterId.parse(randomUUID()), date: today, ml: oz * ML_PER_FL_OZ, loggedAt: Millis.parse(now - (4 - i) * HOUR_MS) },
  }));
  const start = now - 13.4 * HOUR_MS;
  const past = [16.5, 17.2, 16.1, 16.8, 14.6, 18.3, 16.2].flatMap((hours, i): Mutation[] => {
    const fast: Fast = { id: FastId.parse(randomUUID()), startedAt: Millis.parse(start - (i + 1) * 24 * HOUR_MS), targetHours: 16 };
    const end: FastEnd = { id: FastEndId.parse(randomUUID()), fastId: fast.id, endedAt: Millis.parse(fast.startedAt + hours * HOUR_MS) };
    return [
      { op: 'put', kind: 'fast', doc: fast },
      { op: 'put', kind: 'fastEnd', doc: end },
    ];
  });
  const open: Fast = { id: FastId.parse(randomUUID()), startedAt: Millis.parse(start), targetHours: 16 };
  return [...cleared, ...drinks, { op: 'put', kind: 'fast', doc: open }, ...past];
}

/**
 * Ninety days of weigh-ins drifting down with day-to-day noise and a few skipped days, and
 * two workouts today, replacing any other specs left.
 */
function bodyDocs(): Mutation[] {
  const today = localDate();
  const cleared = [
    ...stored('weighIn').map((w): Mutation => ({ op: 'delete', kind: 'weighIn', id: w.id })),
    ...stored('workout').map((w): Mutation => ({ op: 'delete', kind: 'workout', id: w.id })),
  ];
  const weighIns = Array.from({ length: 90 }, (_, i) => i).flatMap((i): Mutation[] => {
    if (i % 9 === 4 || i % 13 === 7) return [];
    const date = addDays(today, i - 89);
    const pounds = 192 - 0.12 * i + 1.1 * Math.sin(i * 1.7) + 0.6 * Math.sin(i * 0.37 + 1);
    return [{ op: 'put', kind: 'weighIn', doc: { id: weighInId(date), date, kg: pounds * KG_PER_LB, loggedAt: Millis.parse(Date.now()) } }];
  });
  const kg = 181.4 * KG_PER_LB;
  const workouts = [metDraft('strength', 50), metDraft('walk_3_5', 30)].map((draft, i): Mutation => ({
    op: 'put',
    kind: 'workout',
    doc: makeWorkout(draft, { id: WorkoutId.parse(randomUUID()), date: today, kg, loggedAt: Millis.parse(Date.now() - (3 - i) * HOUR_MS) }),
  }));
  return [...cleared, ...weighIns, ...workouts];
}

/**
 * A full day of invented food, with a long name and a brand or two, so the diary photographs as a
 * real day reads, and a day after it over its target.
 */
function busyDocs(): Mutation[] {
  const today = localDate();
  const logged = (date: LocalDate, meal: Meal, name: string, nutrients: Food['nutrients'], amount: number, brand?: string): Mutation => ({
    op: 'put',
    kind: 'entry',
    doc: makeEntry(grams({ ...libraryFood(name, nutrients), ...(brand === undefined ? {} : { brand }) }, amount), { date, meal }, EntryId.parse(randomUUID()), Millis.parse(Date.now())),
  });
  return [
    logged(today, 'breakfast', 'Black coffee', { kcal: 2, protein: 0.1, carbs: 0, fat: 0 }, 350),
    logged(today, 'breakfast', 'Sourdough toast with salted butter and a thick layer of raspberry preserves', { kcal: 310, protein: 7, carbs: 45, fat: 11 }, 80, 'Corner Bakery'),
    logged(today, 'lunch', 'Clementine', { kcal: 47, protein: 0.9, carbs: 12, fat: 0.2 }, 150),
    logged(today, 'dinner', 'Salmon fillet', { kcal: 208, protein: 20, carbs: 0, fat: 13 }, 170),
    logged(today, 'dinner', 'Green beans', { kcal: 35, protein: 1.8, carbs: 7, fat: 0.2 }, 120),
    logged(today, 'snacks', 'Peanut butter protein bar', { kcal: 410, protein: 30, carbs: 38, fat: 16 }, 60, 'Trailhead'),
    logged(addDays(today, 1), 'dinner', 'Birthday dinner out', { kcal: 240, protein: 9, carbs: 22, fat: 12 }, 1500),
  ];
}

/** A Wednesday far from any other spec's dates, so the week photographs the same on any run date. */
const TRAIN_MONDAY = '2031-12-01';
const TRAIN_NOON = new Date('2031-12-03T12:00:00');
const LAST_WEEK = '2031-11-25';
/** After every other clock, Progress's here included, so this day's session is not settled by any of them. */
const SESSION_MONDAY = '2034-01-02';
const SESSION_DAY = '2034-01-04';
const SESSION_LAST_WEEK = '2033-12-27';
const SESSION_NOW = new Date(`${SESSION_DAY}T18:30:00`);

/**
 * A week of invented training with the longest text the schema allows in spirit: a long report,
 * a long note, a very long lift name and a long day label.
 */
function trainDocs(): Mutation[] {
  const longName = 'Single-arm cable press with a pause and a slow three-second lowering phase';
  const press = slot('a1', 'single-arm-cable-press', 3, {
    label: longName,
    target: target(3, 8, 12, { perSide: 'left-first' }),
    cue: 'Invented cue. Keep the tempo even and let the cable set the pace, so every rep looks the same from the first to the last.',
    swaps: [{ liftId: lift('landmine-press'), label: 'Landmine press' }, { liftId: lift('machine-press'), label: 'Machine press' }],
  });
  const row = slot('a2', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) });
  const upper = {
    key: 'upper',
    label: 'Upper body strength and accessory work',
    weekday: 1,
    minutes: 55,
    blocks: [
      checklist('warm', { title: 'Warm up', items: ['Band pull-apart', 'Easy row, 3 minutes'] }),
      liftsBlock('pair', [press, row], { restSeconds: 75, note: 'Invented note: move straight from the press to the row, then rest.' }),
      liftsBlock('main', [slot('b1', 'pin-press', 4, { label: 'Pin press', target: target(4, 5, 5), cue: 'Invented cue about bar path.' })], { title: 'Main lift', restSeconds: 150 }),
      liftsBlock('extra', [slot('c1', 'reverse-crunch', 2, { label: 'Reverse crunch', target: target(2, 12, 15, { load: 'bodyweight' }) })], { title: 'Extras', optional: true }),
      cardio('ride', { title: 'Easy ride', optional: true }),
    ],
  };
  const days = [
    upper,
    { key: 'lower', label: 'Lower body', weekday: 2, minutes: 60, blocks: [liftsBlock('main', [slot('d1', 'front-squat', 4, { label: 'Front squat', target: target(4, 6, 8) })])] },
    { key: 'pull', label: 'Pull', weekday: 3, minutes: 45, blocks: [liftsBlock('main', [slot('e1', 'pendlay-row', 3, { label: 'Pendlay row', target: target(3, 8, 12) })])] },
    { key: 'full', label: 'Full body', weekday: 5, minutes: 50, blocks: [liftsBlock('main', [slot('f1', 'trap-bar-deadlift', 3, { label: 'Trap bar deadlift', target: target(3, 6, 10) })])] },
  ];
  const before = program('2031-11-24', [{ ...upper, blocks: upper.blocks.slice(0, 3) }, ...days.slice(1)], { standing: [{ key: 'rules', title: 'Rules', text: 'Stop two reps short of failure on everything but the last set.' }] });
  const version = program(TRAIN_MONDAY, days, {
    weeklyMinimum: 3,
    publishedAt: ms(new Date('2031-11-30T07:02:00').getTime()),
    report: {
      text: 'Invented report. Three sessions last week against a minimum of three, and the main lifts all moved a little. The pin press went up five pounds and held for every set, so it stays there for one more week before going up again. Keep the extras short when time is tight, because the main lift is what the week is built around. The logs looked steady, so nothing else changes. The new extras block is optional and can go first if the gym is busy, and the easy ride is there for any day with time left over.',
    },
    changes: [{ target: 'block:upper/extra', why: 'A short block to finish on when there is time.' }],
    notes: [
      { text: 'The gym closes early on Friday.', onlyWeek: day(TRAIN_MONDAY) },
      { title: 'A longer note', text: 'Invented note that runs long on purpose. A rest day can move anywhere in the week, and two lighter days in a row are fine, as long as the week still reaches its minimum by Sunday. If a day has to go, drop the optional blocks first and keep the main lift.' },
      { text: 'Bring chalk for the pin press.', day: dayKey('upper') },
    ],
    standing: [
      { key: 'rules', title: 'Rules', text: 'Stop two reps short of failure on everything but the last set.\n\nAdd weight when every set reaches the top of its range.' },
      { key: 'phases', title: 'How the year is laid out', text: 'Invented plan. '.repeat(40).trim() },
      { key: 'sources', title: 'Sources', text: 'Invented sources for the plan above.' },
    ],
  });
  const upperDone = session({ date: day(TRAIN_MONDAY), day: { key: dayKey('upper'), label: upper.label }, finishedAt: minutes(60), programId: version.id });
  const lowerDone = session({ date: day('2031-12-03'), day: { key: dayKey('lower'), label: 'Lower body' }, finishedAt: minutes(60), programId: version.id });
  const performances = [
    performance({ date: LAST_WEEK, lift: 'single-arm-cable-press', sets: [sides(32.5, 12, 11), sides(32.5, 11, 10), sides(32.5, 10, 10)] }),
    performance({ date: LAST_WEEK, lift: 'seal-row', sets: [kg(40, 12), kg(40, 12), kg(40, 12)], target: target(3, 8, 12) }),
    performance({ date: LAST_WEEK, lift: 'pin-press', sets: [lb(185, 5), lb(185, 5), lb(185, 5), lb(185, 4)] }),
    performance({ date: LAST_WEEK, lift: 'reverse-crunch', sets: [bw(15), bw(14)] }),
    performance({ session: upperDone.id, date: TRAIN_MONDAY, slot: 'b1', lift: 'pin-press', sets: [lb(190, 5)] }),
    performance({ session: lowerDone.id, date: '2031-12-03', slot: 'd1', lift: 'front-squat', sets: [lb(155, 8)] }),
  ];
  return [
    ...performances.map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
    ...[upperDone, lowerDone].map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...[before, version].map((doc): Mutation => ({ op: 'put', kind: 'program', doc })),
  ];
}

/** A Wednesday after every other spec's dates, with a version of its own in effect. */
const PROGRESS_NOON = new Date('2033-03-02T12:00:00');
const PROGRESS_MONDAY = '2033-02-28';
const LONG_LIFT = 'Single-arm cable press with a pause and a slow three-second lowering phase';

/**
 * Invented training photographed at its awkward cases: a swap, a best long ago, kg beside lb, a
 * very long name, a value past a thousand, a lift with no weight, and lifts done once or never.
 */
function progressDocs(): Mutation[] {
  const monday = day(PROGRESS_MONDAY);
  const weeksBack = (weeks: number, weekday = 0) => addDays(monday, weekday - 7 * weeks);
  const days = ['press', 'row', 'squat', 'full'].map((key, i) => ({ key, label: `Day ${key}`, weekday: i + 1, blocks: [liftsBlock('main', [slot(`${key}1`, 'floor-press', 3)])] }));
  const names = [
    ['floor-press', 'Floor press', true],
    ['meadows-row', 'Meadows row', true],
    ['long-press', LONG_LIFT, true],
    ['sled-leg-press', 'Sled leg press', true],
    ['dragon-flag', 'Dragon flag', true],
    ['yates-row', 'Yates row', true],
    ['nordic-curl', 'Nordic curl', true],
    ['landmine-press', 'Landmine press', false],
    ['band-pull-apart', 'Band pull-apart', false],
  ] as const;
  const version = program('2033-01-03', days, { weeklyMinimum: 3, lifts: names.map(([id, name, key]) => ({ id: lift(id), name, aliases: [], key })) });

  const counts = [3, 4, 2, 3, 4, 3, 1, 3, 2, 4, 3];
  const sessions = counts.flatMap((n, i) => Array.from({ length: n }, (_, s) => session({ date: weeksBack(counts.length - i, s), finishedAt: minutes(60) })));
  const thisWeek = session({ date: monday, finishedAt: minutes(60) });

  const pressRange = target(3, 8, 12);
  const press = Array.from({ length: 60 }, (_, w) => w).flatMap((w) => {
    const date = String(weeksBack(w, 0));
    if (w === 5) return [performance({ lift: 'landmine-press', planned: 'floor-press', label: 'Landmine press', date, sets: [lb(35, 12), lb(35, 12), lb(35, 10)] })];
    if (w === 22) return [performance({ lift: 'landmine-press', planned: 'floor-press', label: 'Landmine press', date, sets: [lb(30, 12)] })];
    if (w === 23) return [performance({ lift: 'landmine-press', planned: 'floor-press', label: 'Landmine press', date, sets: [lb(30, 12)] })];
    if (w === 0) return [performance({ session: thisWeek.id, lift: 'floor-press', date, target: pressRange, sets: [warm(lb(30, 10)), lb(55, 10), lb(55, 9), lb(55, 9)] })];
    const load = 55 - Math.floor(w / 4) * 2.5;
    const reps = 12 - (w % 4);
    return [performance({ lift: 'floor-press', date, target: pressRange, sets: [lb(load, reps), lb(load, reps), lb(load, Math.max(6, reps - 1))] })];
  });
  const row = [0, 1, 2, 3, 4, 5, 6, 7].map((w) => performance({ lift: 'meadows-row', date: String(weeksBack(w, 1)), target: target(3, 8, 12), sets: w === 5 ? [lb(135, 12), lb(135, 12), lb(135, 12)] : [lb(130, 12), lb(130, 12), lb(130, 12)] }));
  const longPress = [
    performance({ lift: 'long-press', label: LONG_LIFT, date: String(weeksBack(6, 2)), target: target(3, 8, 12, { perSide: 'left-first' }), sets: [sides(30, 10, 9), sides(30, 9, 9), sides(30, 9, 8)] }),
    performance({ lift: 'long-press', label: LONG_LIFT, date: String(weeksBack(4, 2)), target: target(3, 8, 12, { perSide: 'left-first' }), sets: [kg(15, 11), kg(15, 10), kg(15, 10)] }),
    performance({ lift: 'long-press', label: LONG_LIFT, date: String(weeksBack(2, 2)), target: target(3, 8, 12, { perSide: 'left-first' }), sets: [sides(35, 10, 10), sides(35, 10, 9), sides(35, 9, 9)] }),
    performance({ lift: 'long-press', label: LONG_LIFT, date: String(weeksBack(1, 2)), target: target(3, 8, 12, { perSide: 'left-first' }), sets: [kg(17.5, 11), kg(17.5, 10), kg(17.5, 9)] }),
  ];
  const sled = [8, 6, 4, 2, 1].map((w, i) => performance({ lift: 'sled-leg-press', date: String(weeksBack(w, 3)), target: target(3, 8, 10), sets: [lb(850 + i * 20, 10), lb(850 + i * 20, 10), lb(850 + i * 20, 9)] }));
  const flag = [10, 8, 6, 4, 2, 1].map((w, i) => performance({ lift: 'dragon-flag', date: String(weeksBack(w, 4)), target: target(2, 12, 15, { load: 'bodyweight' }), sets: [bw(8 + i), bw(7 + i)] }));
  const once = [performance({ lift: 'yates-row', date: String(weeksBack(3, 2)), target: target(3, 8, 12), sets: [lb(95, 10), lb(95, 9), lb(95, 8)] })];
  const banded = [3, 1].map((w, i) => performance({ lift: 'band-pull-apart', date: String(weeksBack(w, 0)), sets: [band('green', 15 + i), band('green', 14 + i)] }));
  const unplaced = [performance({ lift: 'sled-push', label: 'Sled push', date: String(weeksBack(9, 1)), sets: [lb(180, 20)] })];

  return [
    { op: 'put', kind: 'program', doc: version },
    ...[...sessions, thisWeek].map((doc): Mutation => ({ op: 'put', kind: 'session', doc })),
    ...[...press, ...row, ...longPress, ...sled, ...flag, ...once, ...banded, ...unplaced].map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })),
  ];
}

/** A day with sets already logged, holding every kind of exercise. */
function sessionDocs(): Mutation[] {
  const press = slot('s1', 'single-arm-cable-press', 3, {
    label: 'Single-arm cable press with a pause and a slow three-second lowering phase',
    target: target(3, 8, 12, { perSide: 'left-first' }),
    cue: 'Invented cue. Keep the tempo even and let the cable set the pace.',
    swaps: [{ liftId: lift('landmine-press'), label: 'Landmine press' }, { liftId: lift('machine-press'), label: 'Machine press' }],
  });
  const row = slot('s2', 'seal-row', 3, { label: 'Seal row', target: target(3, 8, 12) });
  const version = program(SESSION_MONDAY, [
    {
      key: 'full',
      label: 'Upper body strength and accessory work',
      weekday: 3,
      minutes: 55,
      blocks: [
        checklist('warm', { title: 'Warm up', items: ['Band pull-apart', 'Easy row, 3 minutes'] }),
        liftsBlock('pair', [press, row], { restSeconds: 75, note: 'Invented note: move straight from the press to the row, then rest.' }),
        liftsBlock('main', [slot('s3', 'pin-press', 4, { label: 'Pin press', target: target(4, 5, 5) })], { title: 'Main lift', restSeconds: 150 }),
        liftsBlock('carry', [slot('s4', 'farmer-carry', 2, { label: 'Farmer carry', target: target(2, 1, 1), setPrompt: 'Distance, if you measured it' })], { restSeconds: 60 }),
        liftsBlock('bands', [slot('s5', 'band-face-pull', 2, { label: 'Band face pull', target: target(2, 15, 20, { load: 'band' }) })], { restSeconds: 45 }),
        liftsBlock('extra', [slot('s6', 'reverse-crunch', 2, { label: 'Reverse crunch', target: target(2, 12, 15, { load: 'bodyweight' }) })], { title: 'Extras', optional: true }),
        cardio('ride', { title: 'Easy ride', optional: true }),
      ],
    },
  ]);
  const open = session({ date: day(SESSION_DAY), day: { key: dayKey('full'), label: 'Upper body strength and accessory work' }, programId: version.id, startedAt: ms(SESSION_NOW.getTime() - 19 * 60_000), checked: [checklist('warm').id] });
  const tap = (secondsAgo: number) => ({ at: ms(SESSION_NOW.getTime() - secondsAgo * 1000) });
  const performances = [
    performance({ date: SESSION_LAST_WEEK, lift: 'single-arm-cable-press', sets: [sides(32.5, 12, 11), sides(32.5, 11, 10), sides(32.5, 10, 10)] }),
    performance({ date: SESSION_LAST_WEEK, lift: 'seal-row', sets: [kg(40, 12), kg(40, 12), kg(40, 12)], target: target(3, 8, 12) }),
    performance({ date: '2033-12-20', lift: 'pin-press', sets: [lb(185, 5), lb(185, 5), lb(185, 5), lb(185, 4)] }),
    performance({ date: SESSION_LAST_WEEK, lift: 'machine-press', planned: 'pin-press', label: 'Machine press', sets: [lb(140, 8), lb(140, 8)] }),
    performance({ date: SESSION_LAST_WEEK, lift: 'band-face-pull', sets: [band('green', 18), band('green', 16)] }),
    performance({ date: SESSION_LAST_WEEK, lift: 'reverse-crunch', sets: [bw(15), bw(14)] }),
    performance({ session: open.id, date: SESSION_DAY, slot: 's1', lift: 'single-arm-cable-press', label: press.label, sets: [{ ...sides(25, 12, 12), warmup: true, ...tap(960) }, { ...sides(32.5, 12, 11), ...tap(240) }], target: press.target }),
    performance({ session: open.id, date: SESSION_DAY, slot: 's2', lift: 'seal-row', label: row.label, sets: [{ ...kg(40, 12), ...tap(27) }], target: row.target }),
  ];
  return [...performances.map((doc): Mutation => ({ op: 'put', kind: 'performance', doc })), { op: 'put', kind: 'session', doc: open }, { op: 'put', kind: 'program', doc: version }];
}

test('seeds a day worth photographing', async ({ page, request }) => {
  await seed(request, [...reuseDocs(), ...habitDocs(), ...bodyDocs(), ...busyDocs(), ...trainDocs(), ...progressDocs(), ...sessionDocs()]);
  await page.goto('/');
  await setGoal(page);
  await openRow(page, 'Weekly goal');
  await page.getByLabel('Goal weight').fill('170');
  await saveGoal(page);

  await tab(page, 'Diary').click();
  await page.getByRole('button', { name: 'Add to Breakfast' }).click();
  await page.getByRole('button', { name: 'New food' }).click();
  const editor = page.getByRole('dialog', { name: 'New food' });
  await editor.getByLabel('Name', { exact: true }).fill('Overnight oats');
  await editor.getByLabel('Serving 1 name').fill('1 jar');
  await editor.getByLabel('Serving 1 size').fill('250');
  for (const [label, value] of [
    ['Calories', '380'],
    ['Protein', '18'],
    ['Carbs', '52'],
    ['Fat', '11'],
  ] as const) {
    await editor.getByLabel(label).fill(value);
  }
  await editor.getByText('Fiber, sugar, sodium').click();
  await editor.getByLabel('Fiber').fill('8');
  await editor.getByRole('button', { name: 'Save food' }).click();
  await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Log to Breakfast' }).click();

  await page.getByRole('button', { name: 'Add to Lunch' }).click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  const quick = page.getByRole('dialog', { name: 'Quick add' });
  await quick.getByLabel('What').fill('Chicken burrito bowl');
  await quick.getByLabel('Calories').fill('760');
  await quick.getByLabel('Protein').fill('48');
  await quick.getByRole('button', { name: 'Log to Lunch' }).click();
  await expect.poll(() => stored('entry').map((e) => e.food.name), { timeout: 15_000 }).toContain('Chicken burrito bowl');
});

/**
 * A keyboard, drawn so the shot shows it, and reported the way iOS reports one: the visual viewport
 * shrinks and the layout viewport stays. Real keyboards do not appear under Playwright. It takes 45%
 * of the screen, more than an iPhone's 336 of 874 points, and answers with the height left.
 */
async function raiseKeyboard(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error('no visual viewport');
    const px = Math.round(document.documentElement.clientHeight * 0.45);
    const height = document.documentElement.clientHeight - px;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => height });
    viewport.dispatchEvent(new Event('resize'));
    const keys = document.createElement('div');
    keys.id = 'drawn-keyboard';
    keys.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${px}px;z-index:100;background:#8e8e93;`;
    document.body.append(keys);
    return height;
  });
}

async function lowerKeyboard(page: Page) {
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error('no visual viewport');
    Reflect.deleteProperty(viewport, 'height');
    viewport.dispatchEvent(new Event('resize'));
    document.getElementById('drawn-keyboard')?.remove();
  });
}

async function boxOf(page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`nothing to measure in ${page.url()}`);
  return box;
}

/** Polled, because the sheet under the button may still be sliding in. */
async function expectAboveKeyboard(page: Page, button: Locator, keysAt: number, name: string) {
  await expect
    .poll(async () => {
      const box = await boxOf(page, button);
      return box.y + box.height;
    }, { message: `the keyboard does not hide ${name}` })
    .toBeLessThanOrEqual(keysAt);
}

/** What an exercise promises: Log set in the thumb's reach, every action on screen at 44 points or more, and nothing under the tab bar. */
async function expectClearLayout(page: Page) {
  await expect(async () => {
    const log = await boxOf(page, page.locator('.log-set'));
    const controls = await boxOf(page, page.locator('.set-controls'));
    const focus = await boxOf(page, page.locator('.focus'));
    const heading = await boxOf(page, page.locator('.focus h1'));
    const bar = await boxOf(page, page.getByRole('navigation', { name: 'Sections' }));
    const height = await page.evaluate(() => window.innerHeight);
    expect(log.y + log.height / 2, 'Log set sits in the thumb’s reach').toBeGreaterThan(height * 0.6);
    expect(controls.y + controls.height, 'nothing sits under the tab bar').toBeLessThanOrEqual(bar.y + 0.5);
    expect(heading.y, 'the exercise starts inside its area').toBeGreaterThanOrEqual(focus.y - 0.5);
    expect(heading.y + heading.height, 'and clears the controls').toBeLessThanOrEqual(controls.y + 0.5);
    for (const action of await page.locator('.quiet-actions button').all()) {
      const box = await boxOf(page, action);
      expect(box.height, 'a quiet action is a full tap target').toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, 'and fits across the screen').toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    }
  }).toPass({ timeout: 2000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the exercise does not scroll sideways').toBe(true);
}

/** One exercise from the day's list. Opening one writes nothing, so every photo starts from the same seeded day. */
async function openExercise(page: Page, name: string | RegExp) {
  await page.locator('.train').getByRole('button', { name }).first().click();
  await expect(page.locator('.set-card')).toBeVisible();
}

const backToDay = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();

async function photographExercises(page: Page, name: (shot: string) => string) {
  const shoot = async (shot: string) => page.screenshot({ path: join(dir, name(shot)), animations: 'disabled' });
  await page.clock.setFixedTime(SESSION_NOW);
  await page.goto('/');
  await tab(page, 'Train').click();
  await expect(page.getByTestId('week-count')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Upper body strength and accessory work/ }).click();
  await expect(page.locator('.train').getByRole('button', { name: /^Seal row/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the day does not scroll sideways').toBe(true);
  await expectFullTapTargets(page, 'the day');
  await shoot('day');
  await page.getByRole('region', { name: 'Optional' }).getByText('Optional', { exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shoot('day-bottom');
  await page.evaluate(() => window.scrollTo(0, 0));

  await openExercise(page, /^Seal row/);
  await expect(page.getByTestId('round')).toHaveText('Set 2 of 3');
  await expect(page.getByLabel('Reps', { exact: true })).toHaveValue('12');
  await expectClearLayout(page);
  await expectFullTapTargets(page, 'an exercise');
  await shoot('exercise');

  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  const swap = page.getByRole('dialog', { name: 'Swap' });
  await swap.getByLabel('Another lift').fill('Zottman curl');
  await shoot('swap');
  await swap.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note.getByRole('radio', { name: 'This exercise' })).toBeChecked();
  const aboveNoteKeys = await raiseKeyboard(page);
  await shoot('note-keyboard');
  await expectAboveKeyboard(page, note.getByRole('button', { name: 'Save note' }), aboveNoteKeys, 'Save note');
  await lowerKeyboard(page);
  await note.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const skip = page.getByRole('dialog', { name: /^Skip/ });
  await skip.getByLabel('Why (optional)').focus();
  const aboveSkipKeys = await raiseKeyboard(page);
  await expectAboveKeyboard(page, skip.getByRole('button', { name: 'Skip it' }), aboveSkipKeys, 'Skip it');
  await lowerKeyboard(page);
  await skip.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('group', { name: "Today's sets" }).getByRole('button').first().click();
  const edit = page.getByRole('dialog', { name: /^Edit/ });
  await expect(edit).toBeVisible();
  await shoot('edit-set');
  await edit.getByLabel('Load', { exact: true }).focus();
  const aboveEditKeys = await raiseKeyboard(page);
  await expectAboveKeyboard(page, edit.getByRole('button', { name: 'Save set' }), aboveEditKeys, 'Save set');
  await lowerKeyboard(page);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await backToDay(page);

  await openExercise(page, /^Pin press/);
  await expect(page.getByText('Last time: Machine press')).toBeVisible();
  await expectClearLayout(page);
  await shoot('swap-hint');
  await backToDay(page);

  await openExercise(page, /^Farmer carry/);
  await expect(page.getByLabel('Distance, if you measured it')).toBeVisible();
  await expectClearLayout(page);
  await shoot('prompt');
  await page.getByLabel('Distance, if you measured it').focus();
  const abovePromptKeys = await raiseKeyboard(page);
  const logSet = await boxOf(page, page.getByRole('button', { name: 'Log set' }));
  expect(logSet.y + logSet.height, 'the keyboard does not hide Log set on a note field').toBeLessThanOrEqual(abovePromptKeys);
  const promptField = await boxOf(page, page.getByLabel('Distance, if you measured it'));
  const inputs = await boxOf(page, page.locator('.set-inputs'));
  expect(promptField.y, 'nor the field being typed in').toBeGreaterThanOrEqual(inputs.y);
  expect(promptField.y + promptField.height, 'nor the field being typed in').toBeLessThanOrEqual(inputs.y + inputs.height + 1);
  await shoot('prompt-keyboard');
  await lowerKeyboard(page);
  await backToDay(page);

  await openExercise(page, /^Band face pull/);
  await expect(page.getByLabel('Band', { exact: true })).toHaveValue('green');
  await expectClearLayout(page);
  await shoot('band');
  await backToDay(page);

  await openExercise(page, /^Single-arm cable press/);
  await expect(page.locator('.set-row-unit.side')).toHaveText(['L', 'R']);
  await expectClearLayout(page);
  await expectFullTapTargets(page, 'a per-side exercise with a long name');
  await shoot('per-side');
  await backToDay(page);

  await openExercise(page, /^Reverse crunch/);
  await expect(page.getByText('Bodyweight', { exact: true })).toBeVisible();
  await expectClearLayout(page);
  await shoot('bodyweight');
  await backToDay(page);

  await page.locator('.train').getByRole('button', { name: /^Easy ride/ }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await logger.getByRole('region', { name: 'Walking' }).getByRole('button', { name: /^Walking, 3 mph/ }).click();
  await logger.getByLabel('Duration').focus();
  const aboveLoggerKeys = await raiseKeyboard(page);
  await expectAboveKeyboard(page, logger.getByRole('button', { name: 'Log workout' }), aboveLoggerKeys, 'Log workout');
  await lowerKeyboard(page);
  await logger.getByRole('button', { name: 'Cancel' }).click();
}

/** What every food screen promises: nothing to tap under 44 points, and nothing wider than the phone. */
async function expectFullTapTargets(page: Page, what: string) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, summary, select, label.button')].flatMap((el) => {
      const { width, height } = el.getBoundingClientRect();
      return width > 0 && (width < 44 || height < 44) ? [`${el.getAttribute('aria-label') ?? el.textContent?.trim()}: ${Math.round(width)}×${Math.round(height)}`] : [];
    }),
  );
  expect(small, `${what} has nothing to tap under 44 points`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${what} does not scroll sideways`).toBe(true);
}

/** The food screens at the suffix's width and scheme, each checked for its tap targets. */
async function photographFood(page: Page, suffix: string) {
  const shot = async (name: string, what: string) => {
    await expectFullTapTargets(page, what);
    await page.screenshot({ path: join(dir, `${name}-${suffix}.png`), animations: 'disabled', style: '.toast { display: none; }' });
  };
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Breakfast' }).getByText('Overnight oats')).toBeVisible({ timeout: 15_000 });
  await shot('today', 'the diary');

  await page.getByRole('button', { name: /^Fasting/ }).click();
  await expect(page.getByRole('dialog', { name: 'Fasting' }).getByTestId('fast-clock')).toBeVisible();
  await shot('fast-timer', 'the Fasting sheet');
  await page.getByRole('dialog', { name: 'Fasting' }).getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /^Water/ }).click();
  await expect(page.getByRole('dialog', { name: 'Water' }).getByRole('list', { name: 'Drinks' })).toBeVisible();
  await shot('water-sheet', 'the Water sheet');
  await page.getByRole('dialog', { name: 'Water' }).getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /^Weight/ }).click();
  await expect(page.getByRole('dialog', { name: 'Weight' }).getByTestId('trend-weight')).toBeVisible();
  await shot('weight', 'the Weight sheet');
  await page.getByRole('dialog', { name: 'Weight' }).getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Breakfast options' }).click();
  await shot('meal-menu', 'the meal menu');
  await page.getByRole('dialog', { name: 'Breakfast' }).getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('region', { name: 'Workouts' }).getByRole('button', { name: 'Add workout' }).click();
  const logger = page.getByRole('dialog', { name: 'Add workout' });
  await shot('workout-picker', 'the workout picker');
  await logger.getByRole('region', { name: 'Running' }).getByRole('button', { name: /^Running, 6 mph/ }).click();
  await shot('workout-logger', 'the workout logger');
  await logger.getByRole('button', { name: 'Cancel' }).click();

  await tab(page, 'Add').click();
  await expect(page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: /^Overnight oats/ })).toBeVisible();
  await shot('add', 'Add');
  await page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: /^Overnight oats/ }).click();
  const log = page.getByRole('dialog', { name: 'Log food' });
  await shot('food-sheet', 'the Log food sheet');
  await log.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'New food' }).click();
  const editor = page.getByRole('dialog', { name: 'New food' });
  await shot('food-editor', 'the food editor');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await shot('scan', 'the Scan sheet');
  await page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Cancel' }).click();

  await tab(page, 'Goal').click();
  await expect(page.getByTestId('goal-kcal')).not.toHaveText('–');
  await shot('goal', 'Goal');
  await openRow(page, 'Weekly goal');
  await openRow(page, 'Macros');
  await shot('goal-open', 'Goal with its rows open');
}

/** The Progress sheet and every lift sheet worth a look, at the suffix's width and scheme. */
async function photographProgress(page: Page, suffix: string) {
  const shot = (name: string) => page.screenshot({ path: join(dir, `${name}-${suffix}.png`), animations: 'disabled' });
  const fits = async (sheet: Locator, what: string) => {
    const body = sheet.locator('.sheet-body');
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth), `${what} does not scroll sideways`).toBe(true);
    await shot(what);
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await shot(`${what}-bottom`);
    await body.evaluate((el) => el.scrollTo(0, 0));
  };

  await page.clock.setFixedTime(PROGRESS_NOON);
  await page.goto('/');
  await tab(page, 'Train').click();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Progress' });
  await expect(progress.getByTestId('show-up-count')).toHaveText('1 of 4 this week', { timeout: 15_000 });
  await fits(progress, 'progress');
  const blocks = await progress.locator('.show-up svg').boundingBox();
  await page.mouse.move((blocks?.x ?? 0) + (blocks?.width ?? 0) * 0.45, (blocks?.y ?? 0) + 20);
  await expect(progress.getByTestId('show-up-count')).toHaveText(/^\d sessions? (week of .*|this week)$/);
  await shot('progress-scrub');
  await page.mouse.move(0, 0);

  const openLift = async (name: string | RegExp, label: string, what: string) => {
    await progress.getByTestId('board').getByRole('button', { name }).click();
    const sheet = page.getByRole('dialog', { name: label });
    await expect(sheet.getByTestId('lift-head')).toBeVisible();
    await fits(sheet, what);
    return sheet;
  };
  const closeLift = (sheet: Locator) => sheet.getByRole('button', { name: 'Done' }).click();

  const lifted = await openLift(/^Floor press/, 'Floor press', 'lift');
  const chart = lifted.getByTestId('lift-chart');
  const box = await chart.boundingBox();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * 0.4, (box?.y ?? 0) + (box?.height ?? 0) / 2);
  await expect(lifted.getByTestId('chart-readout')).toContainText('lb volume');
  await shot('lift-scrub');
  await page.mouse.move(0, 0);
  await lifted.getByRole('radio', { name: '1 year' }).click();
  await shot('lift-1y');
  await lifted.getByRole('radio', { name: 'All' }).click();
  await shot('lift-all');
  await closeLift(lifted);

  await closeLift(await openLift(/^Meadows row/, 'Meadows row', 'lift-ready'));
  await closeLift(await openLift(/^Single-arm cable press/, LONG_LIFT, 'lift-long-name'));
  await closeLift(await openLift(/^Sled leg press/, 'Sled leg press', 'lift-heavy'));
  await closeLift(await openLift(/^Dragon flag/, 'Dragon flag', 'lift-reps'));
  await closeLift(await openLift(/^Yates row/, 'Yates row', 'lift-one'));

  await progress.getByRole('button', { name: 'All lifts' }).click();
  const all = page.getByRole('dialog', { name: 'All lifts' });
  await expect(all.getByRole('list', { name: 'Every lift' })).toBeVisible();
  await fits(all, 'all-lifts');
  await all.getByLabel('Search lifts').fill('press');
  await shot('all-lifts-search');
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test(`photographs Progress and its lift sheets in ${colorScheme}`, async ({ page }) => {
      await photographProgress(page, colorScheme);
    });

    test.describe('on a small iPhone', () => {
      test.use({ viewport: { width: 320, height: 568 } });

      test(`photographs Progress and its lift sheets in ${colorScheme}`, async ({ page }) => {
        await photographProgress(page, `small-${colorScheme}`);
      });

      test(`photographs the food screens in ${colorScheme}`, async ({ page }) => {
        await photographFood(page, `small-${colorScheme}`);
      });
    });

    test(`photographs Today, habits, the food and reuse sheets and the goal screen in ${colorScheme}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Breakfast' }).getByText('Overnight oats')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('region', { name: 'Lunch' }).getByText('Chicken burrito bowl')).toBeVisible();
      await expect(page.getByTestId('fast-elapsed')).toHaveText(/^13 h/);
      await page.screenshot({ path: join(dir, `today-${colorScheme}.png`), animations: 'disabled' });

      await page.getByRole('button', { name: 'Next day' }).click();
      await expect(page.getByRole('region', { name: 'Dinner' }).getByText('Birthday dinner out')).toBeVisible();
      await page.screenshot({ path: join(dir, `tomorrow-over-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Previous day' }).click();
      await page.getByRole('button', { name: 'Previous day' }).click();
      await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
      await page.screenshot({ path: join(dir, `yesterday-no-goal-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Next day' }).click();

      await page.getByRole('button', { name: /^Fasting/ }).click();
      const timer = page.getByRole('dialog', { name: 'Fasting' });
      await expect(timer.getByRole('list', { name: 'Past fasts' }).getByRole('listitem')).toHaveCount(7);
      await page.screenshot({ path: join(dir, `fast-timer-${colorScheme}.png`), animations: 'disabled' });
      await timer.locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: join(dir, `fast-timer-bottom-${colorScheme}.png`), animations: 'disabled' });
      await timer.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('button', { name: /^Water/ }).click();
      const water = page.getByRole('dialog', { name: 'Water' });
      await expect(water.getByRole('list', { name: 'Drinks' }).getByRole('listitem')).toHaveCount(4);
      await page.screenshot({ path: join(dir, `water-sheet-${colorScheme}.png`), animations: 'disabled' });
      await water.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('region', { name: 'Breakfast' }).getByRole('button', { name: /^Overnight oats/ }).click();
      const entry = page.getByRole('dialog', { name: 'Edit entry' });
      await expect(entry.getByRole('radiogroup', { name: 'Meal' })).toBeVisible();
      await page.screenshot({ path: join(dir, `edit-entry-${colorScheme}.png`), animations: 'disabled' });
      await entry.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Add').click();
      await expect(page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: /^Overnight oats/ })).toBeVisible();
      await page.screenshot({ path: join(dir, `add-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('list', { name: 'Recent foods' }).getByRole('button', { name: /^Overnight oats/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Log food' });
      await expect(sheet.getByTestId('preview-kcal')).toHaveText('380');
      await sheet.getByLabel('Amount').fill('1.5');
      await expect(sheet.getByTestId('preview-kcal')).toHaveText('570');
      await page.screenshot({ path: join(dir, `food-sheet-${colorScheme}.png`), animations: 'disabled' });
      await expect(sheet.getByText('Fiber 12 g')).toBeHidden();
      await sheet.getByTestId('preview-kcal').click();
      await expect(sheet.getByText('Fiber 12 g')).toBeVisible();
      await page.screenshot({ path: join(dir, `food-sheet-open-${colorScheme}.png`), animations: 'disabled' });
      await sheet.getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('button', { name: 'Quick add' }).click();
      const quick = page.getByRole('dialog', { name: 'Quick add' });
      await page.screenshot({ path: join(dir, `quick-add-${colorScheme}.png`), animations: 'disabled' });
      await quick.getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('button', { name: 'New food' }).click();
      const created = page.getByRole('dialog', { name: 'New food' });
      await page.screenshot({ path: join(dir, `food-editor-${colorScheme}.png`), animations: 'disabled' });
      await created.locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: join(dir, `food-editor-bottom-${colorScheme}.png`), animations: 'disabled' });
      await created.getByRole('button', { name: 'Cancel' }).click();

      await page.getByLabel('Search foods').fill('greek yogurt');
      await expect(page.getByRole('list', { name: 'Online results' }).getByRole('listitem').first()).toBeVisible();
      await page.screenshot({ path: join(dir, `add-search-${colorScheme}.png`), animations: 'disabled' });
      await page.getByLabel('Search foods').fill('');

      await page.getByRole('button', { name: 'Scan', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Look up' })).toBeDisabled();
      await page.screenshot({ path: join(dir, `scan-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Cancel' }).click();

      await typeBarcode(page, '4006381333931');
      await expect(page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Create food' })).toBeVisible();
      await page.screenshot({ path: join(dir, `scan-unknown-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Cancel' }).click();

      await typeBarcode(page, LAYS);
      const confirm = page.getByRole('dialog', { name: 'Confirm food' });
      await expect(confirm.getByLabel('Name')).toHaveValue('Classic Potato Chips');
      await page.screenshot({ path: join(dir, `confirm-sheet-${colorScheme}.png`), animations: 'disabled' });
      await confirm.getByText('Per 100 g').click();
      await page.screenshot({ path: join(dir, `confirm-sheet-open-${colorScheme}.png`), animations: 'disabled' });
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Scan' }).getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Add').click();
      await page.getByRole('radio', { name: 'Recipes' }).click();
      await expect(page.getByRole('list', { name: 'Recipes' }).getByRole('button', { name: /^Chicken rice bowl/ })).toBeVisible();
      await page.screenshot({ path: join(dir, `recipes-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('list', { name: 'Recipes' }).getByRole('button', { name: /^Chicken rice bowl/ }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Edit recipe' }).click();
      const builder = page.getByRole('dialog', { name: 'Edit recipe' });
      await expect(builder.getByRole('list', { name: 'Ingredients' }).getByText('Broccoli')).toBeVisible();
      await page.screenshot({ path: join(dir, `recipe-builder-${colorScheme}.png`), animations: 'disabled' });
      await builder.getByRole('button', { name: 'Cancel' }).click();

      await page.getByLabel('Search foods').fill('chicken thigh');
      await page.getByRole('list', { name: 'Your foods' }).getByRole('button', { name: /^Chicken thigh/ }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Edit food' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit food' });
      await editor.getByLabel('Calories').fill('180');
      await editor.getByRole('button', { name: 'Save food' }).click();
      const ask = page.getByRole('alertdialog', { name: 'Also update 1 recipe?' });
      await expect(ask).toBeVisible();
      await page.screenshot({ path: join(dir, `food-edit-prompt-${colorScheme}.png`), animations: 'disabled' });
      await ask.getByRole('button', { name: 'Not now' }).click();
      await page.getByRole('dialog', { name: 'Log food' }).getByRole('button', { name: 'Cancel' }).click();
      await page.getByLabel('Search foods').fill('');

      await page.getByRole('radio', { name: 'Saved meals' }).click();
      const saved = page.getByRole('list', { name: 'Saved meals' });
      await expect(saved.getByText('Usual breakfast')).toBeVisible();
      await page.screenshot({ path: join(dir, `saved-meals-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await saved.getByRole('button', { name: /^Usual breakfast/ }).click();
      const mealSheet = page.getByRole('dialog', { name: 'Saved meal' });
      await expect(mealSheet.getByText('Granola')).toBeVisible();
      await page.screenshot({ path: join(dir, `saved-meal-sheet-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await mealSheet.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Diary').click();
      await page.getByRole('button', { name: 'Breakfast options' }).click();
      const menu = page.getByRole('dialog', { name: 'Breakfast' });
      await expect(menu.getByRole('button', { name: /^Save as a meal/ })).toBeEnabled();
      await page.screenshot({ path: join(dir, `meal-menu-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await menu.getByRole('button', { name: 'Copy from another day' }).click();
      const copying = page.getByRole('dialog', { name: 'Copy from another day' });
      await expect(copying.getByRole('radiogroup', { name: 'Meal' })).toBeVisible();
      await page.screenshot({ path: join(dir, `copy-pick-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await copying.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Breakfast options' }).click();
      await page.getByRole('dialog', { name: 'Breakfast' }).getByRole('button', { name: /^Save as a meal/ }).click();
      const saving = page.getByRole('dialog', { name: 'Save as a meal' });
      await page.screenshot({ path: join(dir, `save-meal-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await saving.getByRole('button', { name: 'Cancel' }).click();

      await tab(page, 'Goal').click();
      await expect(page.getByTestId('goal-kcal')).not.toHaveText('–');
      // The toast from saving a food earlier in this pass would cover the form.
      await page.screenshot({ path: join(dir, `goal-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      // A full-page capture would paint the fixed tab bar mid-page.
      await page.screenshot({ path: join(dir, `goal-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; }' });
    });

    test(`photographs weight, workouts and the budget choice in ${colorScheme}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('day-trend')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('region', { name: 'Workouts' }).getByText('Strength training')).toBeVisible();

      await page.getByRole('button', { name: /^Weight/ }).click();
      const weight = page.getByRole('dialog', { name: 'Weight' });
      await expect(weight.getByTestId('projection')).not.toHaveText('Not enough data');
      await page.screenshot({ path: join(dir, `weight-${colorScheme}.png`), animations: 'disabled' });
      await weight.getByRole('radio', { name: '90 days' }).click();
      await page.screenshot({ path: join(dir, `weight-90-days-${colorScheme}.png`), animations: 'disabled' });
      await weight.locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: join(dir, `weight-bottom-${colorScheme}.png`), animations: 'disabled' });
      await weight.locator('.sheet-body').evaluate((el) => el.scrollTo(0, 0));

      await weight.getByRole('button', { name: 'Weigh in', exact: true }).click();
      const entry = page.getByRole('dialog', { name: 'Weigh-in' });
      await entry.getByLabel('Weight').fill('181.2');
      await page.screenshot({ path: join(dir, `weigh-in-${colorScheme}.png`), animations: 'disabled' });
      await entry.getByRole('button', { name: 'Cancel' }).click();
      await weight.getByRole('button', { name: 'Done' }).click();

      const workouts = page.getByRole('region', { name: 'Workouts' });
      await workouts.getByRole('button', { name: 'Add workout' }).click();
      const logger = page.getByRole('dialog', { name: 'Add workout' });
      await expect(logger.getByRole('list', { name: 'Recent workouts' })).toBeVisible();
      await page.screenshot({ path: join(dir, `workout-picker-${colorScheme}.png`), animations: 'disabled' });
      await logger.getByRole('region', { name: 'Running' }).getByRole('button', { name: /^Running, 6 mph/ }).click();
      await logger.getByRole('button', { name: '45 min', exact: true }).click();
      await expect(logger.getByTestId('workout-kcal')).not.toHaveText('–');
      await page.screenshot({ path: join(dir, `workout-logger-${colorScheme}.png`), animations: 'disabled' });
      await logger.getByRole('button', { name: 'Cancel' }).click();

      await workouts.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `today-workouts-${colorScheme}.png`), animations: 'disabled' });
      await page.screenshot({ path: join(dir, `today-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; }' });

      await tab(page, 'Goal').click();
      await openRow(page, 'Activity');
      await page.screenshot({ path: join(dir, `goal-activity-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await openRow(page, 'Weekly goal');
      await openRow(page, 'Macros');
      await openRow(page, 'Water');
      await openRow(page, 'How this is worked out');
      await page.getByLabel('Daily goal').fill('97');
      await expect(page.getByRole('button', { name: 'Save goal' })).toBeVisible();
      await page.screenshot({ path: join(dir, `goal-changed-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await page.screenshot({ path: join(dir, `goal-open-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; } .screen-actions { position: static; }' });
      await page.getByRole('switch', { name: /^Count workouts/ }).check();
      await page.getByText('Count workouts').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `goal-eat-back-${colorScheme}.png`), animations: 'disabled', style: '.toast { display: none; }' });
      await page.getByLabel('Workouts counted').fill('140');
      await page.getByLabel('Daily goal').fill('0');
      await page.getByLabel('Protein').fill('90');
      await page.locator('summary', { hasText: /^Water/ }).click();
      await page.locator('summary', { hasText: /^Macros/ }).click();
      await expect(page.getByRole('button', { name: 'Save goal' })).toBeDisabled();
      await page.screenshot({ path: join(dir, `goal-invalid-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar, .toast { display: none; } .screen-actions { position: static; }' });
    });

    test(`photographs the Train tab, its sheets and the empty state in ${colorScheme}`, async ({ page }) => {
      await page.clock.setFixedTime(TRAIN_NOON);
      await page.goto('/');
      await tab(page, 'Train').click();
      await expect(page.getByTestId('week-count')).toHaveText('2 of 4 done', { timeout: 15_000 });
      await page.screenshot({ path: join(dir, `train-${colorScheme}.png`), animations: 'disabled' });

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.screenshot({ path: join(dir, `train-bottom-${colorScheme}.png`), animations: 'disabled' });
      const lastRow = await page.getByRole('list', { name: 'More' }).boundingBox();
      const bar = await page.getByRole('navigation', { name: 'Sections' }).boundingBox();
      expect((lastRow?.y ?? Infinity) + (lastRow?.height ?? 0), 'nothing sits under the tab bar').toBeLessThanOrEqual(bar?.y ?? 0);
      // A full-page capture would paint the fixed tab bar mid-page.
      await page.screenshot({ path: join(dir, `train-${colorScheme}-full.png`), fullPage: true, animations: 'disabled', style: '.tab-bar { display: none; }' });

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: /^Coach/ }).click();
      const coach = page.getByRole('dialog', { name: 'Coach' });
      await expect(coach.getByRole('list', { name: 'Changes' }).getByRole('listitem')).not.toHaveCount(0);
      await page.screenshot({ path: join(dir, `train-coach-${colorScheme}.png`), animations: 'disabled' });
      await coach.locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: join(dir, `train-coach-bottom-${colorScheme}.png`), animations: 'disabled' });
      await coach.getByLabel('Tell the coach').focus();
      const aboveCoachKeys = await raiseKeyboard(page);
      const saveCoach = await boxOf(page, coach.getByRole('button', { name: 'Save note' }));
      expect(saveCoach.y + saveCoach.height, 'the keyboard does not hide Save note').toBeLessThanOrEqual(aboveCoachKeys);
      const coachField = await boxOf(page, coach.getByLabel('Tell the coach'));
      expect(coachField.y + coachField.height, 'and Save note does not hide what he is typing').toBeLessThanOrEqual(saveCoach.y + 0.5);
      await page.screenshot({ path: join(dir, `train-coach-keyboard-${colorScheme}.png`), animations: 'disabled' });
      await lowerKeyboard(page);
      await coach.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Upper body/ }).click();
      await expect(page.getByText('40 kg × 12/12/12 · Nov 25')).toBeVisible();
      await page.screenshot({ path: join(dir, `train-day-${colorScheme}.png`), animations: 'disabled' });
      await page.locator('details').filter({ hasText: /^Warm up · / }).locator('summary').click();
      await expect(page.getByRole('button', { name: 'Warm up done' })).toBeVisible();
      await expectFullTapTargets(page, 'a day with its checklist open');
      await page.screenshot({ path: join(dir, `train-day-checklist-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('region', { name: 'Optional' }).getByText('Optional', { exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.screenshot({ path: join(dir, `train-day-bottom-${colorScheme}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Back', exact: true }).click();

      await page.getByRole('button', { name: 'Program', exact: true }).click();
      const standing = page.getByRole('dialog', { name: 'Program' });
      await standing.getByText('How the year is laid out').click();
      await page.screenshot({ path: join(dir, `train-program-${colorScheme}.png`), animations: 'disabled' });
      await standing.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('button', { name: 'Weigh in', exact: true }).click();
      const weighIn = page.getByRole('dialog', { name: 'Weigh-in' });
      await weighIn.getByLabel('Weight').focus();
      const aboveWeighInKeys = await raiseKeyboard(page);
      await expectAboveKeyboard(page, weighIn.getByRole('button', { name: 'Save weigh-in' }), aboveWeighInKeys, 'Save weigh-in');
      await lowerKeyboard(page);
      await weighIn.getByRole('button', { name: 'Cancel' }).click();

      await page.clock.setFixedTime(new Date('2020-01-08T12:00:00'));
      await page.reload();
      await tab(page, 'Train').click();
      await expect(page.getByText('There is no program yet.')).toBeVisible();
      await page.screenshot({ path: join(dir, `train-empty-${colorScheme}.png`), animations: 'disabled' });
    });

    test(`photographs a day and its exercises in ${colorScheme}`, async ({ page }) => {
      await photographExercises(page, (shot) => `exercise-${shot}-${colorScheme}.png`);
    });

    test.describe('on a small iPhone', () => {
      test.use({ viewport: { width: 320, height: 568 } });

      test(`photographs a day and its exercises in ${colorScheme}`, async ({ page }) => {
        await photographExercises(page, (shot) => `exercise-small-${shot}-${colorScheme}.png`);
      });

      test(`photographs the Train tab and a day in ${colorScheme}`, async ({ page }) => {
        await page.clock.setFixedTime(TRAIN_NOON);
        await page.goto('/');
        const tabs = page.getByRole('navigation', { name: 'Sections' }).getByRole('button');
        await expect(tabs).toHaveCount(4);
        for (const button of await tabs.all()) {
          const fits = await button.evaluate((el) => el.scrollWidth <= el.clientWidth);
          expect(fits, await button.innerText()).toBe(true);
        }
        await tab(page, 'Train').click();
        await expect(page.getByTestId('week-count')).toHaveText('2 of 4 done', { timeout: 15_000 });
        await page.screenshot({ path: join(dir, `train-small-${colorScheme}.png`), animations: 'disabled' });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.screenshot({ path: join(dir, `train-small-bottom-${colorScheme}.png`), animations: 'disabled' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the week does not scroll sideways').toBe(true);

        await page.getByRole('list', { name: 'Days' }).getByRole('button', { name: /^Upper body/ }).click();
        await expect(page.getByText('40 kg × 12/12/12 · Nov 25')).toBeVisible();
        await page.screenshot({ path: join(dir, `train-small-day-${colorScheme}.png`), animations: 'disabled' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the day does not scroll sideways').toBe(true);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.screenshot({ path: join(dir, `train-small-day-bottom-${colorScheme}.png`), animations: 'disabled' });
      });
    });
  });
}
