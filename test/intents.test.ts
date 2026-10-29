import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntents, type Intents } from '../src/client/intents.js';
import { InvalidDocument, openReplica, type Replica, type SyncPort } from '../src/client/replica.js';
import { syncRounds } from '../src/client/sync.js';
import {
  bodyView,
  dayView,
  fastView,
  foodWithBarcode,
  goalView,
  recentsView,
  recipesView,
  savedMealsView,
  usesView,
  waterView,
  workoutLoggerView,
} from '../src/client/views.js';
import { metDraft } from '../src/domain/burn.js';
import { itemOf } from '../src/domain/diary.js';
import { Gtin, defaultQuantity, quickAddItem, snapshotOf, type FoodCandidate } from '../src/domain/food.js';
import { KG_PER_LB, type GoalDraft } from '../src/domain/goals.js';
import { DEFAULT_WATER_ML, HOUR_MS, runningFast } from '../src/domain/habits.js';
import { LocalDate, addDays, type Millis } from '../src/domain/ids.js';
import { recipeSnapshot } from '../src/domain/reuse.js';
import { openStore } from '../src/server/store.js';
import { at, entry, food, newEntryId, rev } from './fixtures.js';

const today = LocalDate.parse('2026-10-28');
const slot = { date: today, meal: 'lunch' } as const;
const NOW = at(1_800_000_000_000);
const open: Replica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});

async function setup() {
  const { replica, port } = await openReplica({ name: 'intents', indexedDB: new IDBFactory(), IDBKeyRange });
  open.push(replica);
  return { replica, port, intents: createIntents(replica, { now: () => NOW, newId: randomUUID }) };
}

/** What the next sync would push to the mini. */
async function pushed(port: SyncPort): Promise<unknown[]> {
  const batch = await port.nextBatch(100);
  return batch.mutations.flatMap((m) => (m.op === 'put' ? [m.doc] : []));
}

const yogurt: FoodCandidate = {
  name: 'Greek yogurt',
  brand: 'Fage',
  unit: 'g',
  nutrients: { kcal: 97, carbs: 3.6 },
  servings: [{ label: '1 pot', amount: 170 }],
  barcodes: [Gtin.parse('5201054017661')],
  source: { kind: 'off', gtin: Gtin.parse('5201054017661'), fetchedAt: NOW },
};

describe('logging', () => {
  it('logs quick adds into the day and its kcal total, queued for the mini', async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Burrito', { kcal: 900 }), quickAddItem('', { kcal: 150 })], slot);
    const day = await dayView(replica.read, today);
    expect(day.summary.meals.lunch.entries.map((e) => e.food.name)).toEqual(['Burrito', 'Quick add']);
    expect(day.summary.totals.sum.kcal).toBe(1050);
    expect(day.summary.totals.incomplete.has('protein')).toBe(true);
    expect(await replica.read.pendingCount()).toBe(2);
  });

  it('takes a log back on undo', async () => {
    const { replica, intents } = await setup();
    const { undo } = await intents.logItems([quickAddItem('Latte', { kcal: 190 })], slot);
    await undo();
    expect((await dayView(replica.read, today)).summary.entries).toEqual([]);
  });

  it('deletes an entry and puts it back on undo', async () => {
    const { replica, intents } = await setup();
    const {
      ids: [id],
    } = await intents.logItems([quickAddItem('Latte', { kcal: 190 })], slot);
    if (!id) throw new Error('nothing logged');
    const undo = await intents.deleteEntry(id);
    expect((await dayView(replica.read, today)).summary.entries).toEqual([]);
    await undo();
    expect((await dayView(replica.read, today)).summary.entries.map((e) => e.id)).toEqual([id]);
  });

  it('edits the quantity and moves the entry to another meal', async () => {
    const { replica, intents } = await setup();
    const oats = food();
    const {
      ids: [id],
    } = await intents.logItems([{ food: { ...oats, origin: { kind: 'food', id: oats.id } }, quantity: { kind: 'amount', amount: 40 } }], slot);
    if (!id) throw new Error('nothing logged');
    await intents.editEntry(id, { quantity: { kind: 'amount', amount: 80 }, meal: 'breakfast' });
    const day = await dayView(replica.read, today);
    expect(day.summary.meals.lunch.entries).toEqual([]);
    expect(day.summary.meals.breakfast.totals.sum.kcal).toBe(304);
  });

  it('keeps other days out of the day view', async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Yesterday', { kcal: 100 })], { date: LocalDate.parse('2026-10-27'), meal: 'dinner' });
    expect((await dayView(replica.read, today)).summary.entries).toEqual([]);
  });
});

describe('importAndLog', () => {
  it('refuses a candidate missing core nutrients, naming them', async () => {
    const { replica, intents } = await setup();
    expect(await intents.importAndLog(yogurt, { kind: 'amount', amount: 170 }, slot)).toEqual({ ok: false, missing: ['protein', 'fat'] });
    expect(await replica.read.pendingCount()).toBe(0);
  });

  it('adds the completed food to the library and logs it in one commit, so the barcode answers offline next time', async () => {
    const { replica, port, intents } = await setup();
    const result = await intents.importAndLog(
      { ...yogurt, nutrients: { ...yogurt.nutrients, protein: 9, fat: 5 } },
      { kind: 'serving', serving: { label: '1 pot', amount: 170 }, count: 1 },
      slot,
    );
    expect(result.ok).toBe(true);
    const batch = await port.nextBatch(100);
    expect(batch.mutations.map((m) => m.kind)).toEqual(['food', 'entry']);
    const library = await foodWithBarcode(replica.read, Gtin.parse('5201054017661'));
    expect(library?.name).toBe('Greek yogurt');
    expect((await dayView(replica.read, today)).summary.totals.sum.kcal).toBeCloseTo(164.9);
  });
});

describe('recents', () => {
  it('offer what was logged in the last 90 days with its last quantity', async () => {
    const { replica, intents } = await setup();
    const oats = await intents.createFood({ ...food(), barcodes: [] });
    await intents.logItems([{ food: { ...oats, origin: { kind: 'food', id: oats.id } }, quantity: { kind: 'amount', amount: 55 } }], slot);
    await intents.logItems([quickAddItem('Old', { kcal: 1 })], { date: LocalDate.parse('2026-07-01'), meal: 'lunch' });
    const list = await recentsView(replica.read, { today, now: NOW });
    expect(list.map((r) => [r.food.name, r.lastQuantity])).toEqual([['Oats', { kind: 'amount', amount: 55 }]]);
  });
});

const draft: GoalDraft = {
  policy: { kind: 'activity-level', level: 'moderate' },
  kgPerWeek: -KG_PER_LB,
  macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 },
};

describe('goals', () => {
  it('puts the target and remaining kcal on the day once a profile and goal exist', async () => {
    const { replica, intents } = await setup();
    await intents.saveProfile({ sex: 'male', birthDate: LocalDate.parse('1990-06-15'), heightCm: 180, weightKg: 81 });
    await intents.saveGoal(draft, today);
    await intents.logItems([quickAddItem('Lunch', { kcal: 700 })], slot);
    const { budget, summary } = await dayView(replica.read, today);
    expect(budget?.kcal).toBe(2228);
    expect((budget?.kcal ?? 0) - summary.totals.sum.kcal).toBe(1528);
  });

  it('leaves a past day on its old goal when a new one is saved', async () => {
    const { replica, intents } = await setup();
    await intents.saveGoal({ ...draft, kcalOverride: 2400 }, LocalDate.parse('2026-10-01'));
    await intents.saveGoal({ ...draft, kcalOverride: 2000 }, today);
    expect((await dayView(replica.read, LocalDate.parse('2026-10-27'))).budget?.kcal).toBe(2400);
    expect((await dayView(replica.read, today)).budget?.kcal).toBe(2000);
  });

  it('replaces a goal saved earlier the same day, dropping a cleared override', async () => {
    const { replica, intents } = await setup();
    await intents.saveGoal({ ...draft, kcalOverride: 2400 }, today);
    await intents.saveGoal(draft, today);
    const { goal } = await goalView(replica.read, today);
    expect(goal?.kcalOverride).toBeUndefined();
    expect(await replica.read.all('goal')).toHaveLength(1);
  });
});

describe('documents a newer app wrote', () => {
  it('reach the mini with their unknown fields after this app rewrites them', async () => {
    const { replica, port, intents } = await setup();
    const lunch = { ...entry(newEntryId(), 400), photoId: 'p-1', food: { ...entry(newEntryId(), 400).food, imageUrl: 'x' } };
    const oats = { ...food(), glycemicIndex: 55 };
    const profile = { id: 'me', sex: 'male', birthDate: '1990-06-15', heightCm: 180, weightKg: 81, bodyFat: 18 };
    await port.apply({
      epoch: 'e1',
      lastMutationId: 0,
      rejected: [],
      changes: [
        { kind: 'entry', id: lunch.id, rev: rev(1), doc: lunch },
        { kind: 'food', id: oats.id, rev: rev(2), doc: oats },
        { kind: 'profile', id: 'me', rev: rev(3), doc: profile },
      ],
      cursor: rev(3),
      more: false,
    });

    await intents.editEntry(lunch.id, { quantity: { kind: 'amount', amount: 2 }, meal: 'dinner' });
    await intents.updateFood(oats.id, { ...food(), name: 'Steel-cut oats' });
    await intents.saveProfile({ sex: 'male', birthDate: LocalDate.parse('1990-06-15'), heightCm: 180, weightKg: 80 });

    const [movedLunch, renamedOats, newProfile] = await pushed(port);
    expect(movedLunch).toMatchObject({ photoId: 'p-1', meal: 'dinner', food: { imageUrl: 'x' } });
    expect(renamedOats).toMatchObject({ glycemicIndex: 55, name: 'Steel-cut oats' });
    expect(newProfile).toMatchObject({ bodyFat: 18, weightKg: 80 });
    expect(await replica.read.get('entry', lunch.id)).toMatchObject({ photoId: 'p-1' });
  });
});

describe('recipes', () => {
  const recipeOf = async (intents: Intents) => {
    const beef = await intents.createFood({ ...food(), name: 'Ground beef', nutrients: { kcal: 250, protein: 26, carbs: 0, fat: 15 }, servings: [] });
    const beans = await intents.createFood({ ...food(), name: 'Kidney beans', nutrients: { kcal: 127, protein: 8.7, carbs: 22.8, fat: 0.5 }, servings: [] });
    const recipe = await intents.createRecipe({
      name: 'Chili',
      ingredients: [
        { food: snapshotOf(beef), quantity: { kind: 'amount', amount: 500 } },
        { food: snapshotOf(beans), quantity: { kind: 'amount', amount: 400 } },
      ],
      yield: { servings: 4, cookedGrams: 1600 },
    });
    return { beef, beans, recipe };
  };

  it('log a serving through logItems and show up in recents as the recipe', async () => {
    const { replica, intents } = await setup();
    const { recipe } = await recipeOf(intents);
    const snapshot = recipeSnapshot(recipe);
    await intents.logItems([{ food: snapshot, quantity: defaultQuantity(snapshot) }], slot);
    expect((await dayView(replica.read, today)).summary.totals.sum.kcal).toBeCloseTo(439.5);
    const [recent] = await recentsView(replica.read, { today, now: NOW });
    expect(recent?.food.origin).toEqual({ kind: 'recipe', id: recipe.id });
  });

  it('never change a day already logged when the recipe is edited', async () => {
    const { replica, intents } = await setup();
    const { recipe } = await recipeOf(intents);
    await intents.logItems([{ food: recipeSnapshot(recipe), quantity: { kind: 'amount', amount: 400 } }], slot);
    const { id: _id, archived: _archived, ...draft } = recipe;
    await intents.updateRecipe(recipe.id, { ...draft, yield: { servings: 4, cookedGrams: 2000 } });
    expect((await dayView(replica.read, today)).summary.totals.sum.kcal).toBeCloseTo(439.5);
    const [recent] = await recentsView(replica.read, { today, now: NOW });
    expect(recent?.food.servings).toEqual([{ label: '1 serving', amount: 500 }]);
  });

  it('leave the list when archived, and come back on undo', async () => {
    const { replica, intents } = await setup();
    const { recipe } = await recipeOf(intents);
    const undo = await intents.archiveRecipe(recipe.id);
    expect(await recipesView(replica.read)).toEqual([]);
    await undo();
    expect((await recipesView(replica.read)).map((r) => r.name)).toEqual(['Chili']);
  });

  it('take an ingredient from an online result once its core nutrients are complete, without logging it', async () => {
    const { replica, intents } = await setup();
    expect(await intents.importFood(yogurt)).toEqual({ ok: false, missing: ['protein', 'fat'] });
    const imported = await intents.importFood({ ...yogurt, nutrients: { ...yogurt.nutrients, protein: 9, fat: 5 } });
    expect(imported.ok && (await replica.read.get('food', imported.food.id))?.name).toBe('Greek yogurt');
    expect((await dayView(replica.read, today)).summary.entries).toEqual([]);
  });
});

describe('saved meals', () => {
  it('log every item into any meal in one tap, in order, and undo as one', async () => {
    const { replica, intents } = await setup();
    const breakfast = { date: today, meal: 'breakfast' } as const;
    await intents.logItems([quickAddItem('Eggs', { kcal: 210 }), quickAddItem('Toast', { kcal: 160 })], breakfast);
    const items = (await dayView(replica.read, today)).summary.meals.breakfast.entries.map(itemOf);
    const meal = await intents.saveMeal({ name: 'Usual breakfast', items });
    expect((await savedMealsView(replica.read)).map((m) => m.name)).toEqual(['Usual breakfast']);

    const { undo } = await intents.logItems(meal.items, { date: today, meal: 'dinner' });
    const dinner = (await dayView(replica.read, today)).summary.meals.dinner;
    expect(dinner.entries.map((e) => e.food.name)).toEqual(['Eggs', 'Toast']);
    expect(dinner.totals.sum.kcal).toBe(370);
    await undo();
    expect((await dayView(replica.read, today)).summary.meals.dinner.entries).toEqual([]);
  });

  it('leave the list when archived', async () => {
    const { replica, intents } = await setup();
    const meal = await intents.saveMeal({ name: 'Shake', items: [quickAddItem('Shake', { kcal: 300 })] });
    await intents.archiveMeal(meal.id);
    expect(await savedMealsView(replica.read)).toEqual([]);
  });
});

describe('copying', () => {
  const yesterday = LocalDate.parse('2026-10-27');

  it("copies yesterday's breakfast into today's lunch through logItems", async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Oatmeal', { kcal: 300 }), quickAddItem('Coffee', { kcal: 5 })], { date: yesterday, meal: 'breakfast' });
    const source = (await dayView(replica.read, yesterday)).summary.meals.breakfast.entries;
    await intents.logItems(source.map(itemOf), slot);
    expect((await dayView(replica.read, today)).summary.meals.lunch.entries.map((e) => e.food.name)).toEqual(['Oatmeal', 'Coffee']);
    expect((await dayView(replica.read, yesterday)).summary.entries.map((e) => e.id)).toEqual(source.map((e) => e.id));
  });

  it('copies a whole day with each entry in its own meal, as new entries, and undoes as one', async () => {
    const { replica, intents } = await setup();
    await intents.logItems([quickAddItem('Oatmeal', { kcal: 300 })], { date: yesterday, meal: 'breakfast' });
    await intents.logItems([quickAddItem('Salad', { kcal: 450 })], { date: yesterday, meal: 'lunch' });
    const { ids, undo } = await intents.copyDay(yesterday, today);
    const day = (await dayView(replica.read, today)).summary;
    expect(day.meals.breakfast.entries.map((e) => e.food.name)).toEqual(['Oatmeal']);
    expect(day.meals.lunch.entries.map((e) => e.food.name)).toEqual(['Salad']);
    expect(day.totals.sum.kcal).toBe(750);
    const source = (await dayView(replica.read, yesterday)).summary.entries.map((e) => e.id);
    expect(ids.filter((id) => source.includes(id))).toEqual([]);
    await undo();
    expect((await dayView(replica.read, today)).summary.entries).toEqual([]);
  });
});

describe('after a food edit', () => {
  it('updates the recipes and saved meals that use the food only when asked, never the diary, and undoes', async () => {
    const { replica, intents } = await setup();
    const oats = await intents.createFood({ ...food(), barcodes: [] });
    const item = { food: snapshotOf(oats), quantity: { kind: 'amount', amount: 80 } } as const;
    const recipe = await intents.createRecipe({ name: 'Overnight oats', ingredients: [item], yield: { servings: 2 } });
    const meal = await intents.saveMeal({ name: 'Oats', items: [item] });
    await intents.logItems([item], slot);

    const { id: _id, archived: _archived, ...draft } = oats;
    await intents.updateFood(oats.id, { ...draft, nutrients: { ...oats.nutrients, kcal: 400 } });
    const offer = await usesView(replica.read, { kind: 'food', id: oats.id });
    expect([offer.recipes.length, offer.meals.length]).toEqual([1, 1]);
    expect((await replica.read.get('recipe', recipe.id))?.ingredients[0]?.food.nutrients.kcal).toBe(380);

    const updated = await intents.updateUsesOf({ kind: 'food', id: oats.id });
    expect([updated.recipes, updated.meals]).toEqual([1, 1]);
    expect((await replica.read.get('recipe', recipe.id))?.ingredients[0]?.food.nutrients.kcal).toBe(400);
    expect((await replica.read.get('savedMeal', meal.id))?.items[0]?.food.nutrients.kcal).toBe(400);
    expect((await dayView(replica.read, today)).summary.totals.sum.kcal).toBe(304);
    expect(await usesView(replica.read, { kind: 'food', id: oats.id })).toEqual({ recipes: [], meals: [] });

    await updated.undo();
    expect((await replica.read.get('recipe', recipe.id))?.ingredients[0]?.food.nutrients.kcal).toBe(380);
  });
});

describe('water', () => {
  it('adds one drink per tap toward the goal, and undoes the last', async () => {
    const { replica, intents } = await setup();
    await intents.addWater(250, today);
    const undo = await intents.addWater(500, today);
    await intents.addWater(330, LocalDate.parse('2026-10-27'));
    expect((await waterView(replica.read, today)).totalMl).toBe(750);
    await undo();
    expect((await waterView(replica.read, today)).drinks.map((d) => d.ml)).toEqual([250]);
  });

  it('removes a drink and puts it back on undo', async () => {
    const { replica, intents } = await setup();
    await intents.addWater(250, today);
    const [drink] = (await waterView(replica.read, today)).drinks;
    if (!drink) throw new Error('no drink');
    const undo = await intents.deleteWater(drink.id);
    expect((await waterView(replica.read, today)).totalMl).toBe(0);
    await undo();
    expect((await waterView(replica.read, today)).totalMl).toBe(250);
  });

  it('measures the day against the goal in effect, saved with the calorie goal', async () => {
    const { replica, intents } = await setup();
    expect((await waterView(replica.read, today)).goalMl).toBe(DEFAULT_WATER_ML);
    await intents.saveGoal(
      { policy: { kind: 'activity-level', level: 'moderate' }, kgPerWeek: 0, macros: { kind: 'grams', protein: 150, carbs: 200, fat: 60 }, waterMl: 3000 },
      today,
    );
    expect((await waterView(replica.read, today)).goalMl).toBe(3000);
  });
});

describe('after a recipe edit', () => {
  it('updates the saved meals holding the recipe only when asked', async () => {
    const { replica, intents } = await setup();
    const oats = await intents.createFood({ ...food(), barcodes: [] });
    const recipe = await intents.createRecipe({
      name: 'Overnight oats',
      ingredients: [{ food: snapshotOf(oats), quantity: { kind: 'amount', amount: 80 } }],
      yield: { servings: 2 },
    });
    const snapshot = recipeSnapshot(recipe);
    const meal = await intents.saveMeal({ name: 'Oats', items: [{ food: snapshot, quantity: defaultQuantity(snapshot) }] });
    const { id: _id, archived: _archived, ...draft } = recipe;
    await intents.updateRecipe(recipe.id, { ...draft, yield: { servings: 4 } });

    expect((await usesView(replica.read, { kind: 'recipe', id: recipe.id })).meals.map((m) => m.id)).toEqual([meal.id]);
    expect((await replica.read.get('savedMeal', meal.id))?.items[0]?.food.nutrients.kcal).toBe(152);
    await intents.updateUsesOf({ kind: 'recipe', id: recipe.id });
    expect((await replica.read.get('savedMeal', meal.id))?.items[0]?.food.nutrients.kcal).toBe(76);
  });
});

describe('fasting', () => {
  it('opens one fast for a double tap on Start, and says the second started nothing', async () => {
    const { replica, intents } = await setup();
    const [first, second] = await Promise.all([intents.startFast(16), intents.startFast(16)]);
    expect(await replica.read.all('fast')).toHaveLength(1);
    expect(typeof first).toBe('function');
    expect(second).toBeNull();
  });

  it('starts once, keeps the tap as its start, changes target, ends and undoes the end', async () => {
    const { replica, intents } = await setup();
    await intents.startFast(16);
    await intents.startFast(16);
    const started = await fastView(replica.read, today);
    expect(started.state.kind).toBe('fasting');
    expect(runningFast(started.state)?.startedAt).toBe(NOW);

    await intents.setFastTarget(18);
    expect(runningFast((await fastView(replica.read, today)).state)?.targetHours).toBe(18);

    const undo = await intents.endFast();
    const ended = await fastView(replica.read, today);
    expect(ended.state).toEqual({ kind: 'idle' });
    expect(ended.history).toHaveLength(1);
    expect(ended.nextTargetHours).toBe(18);
    await undo();
    expect((await fastView(replica.read, today)).state.kind).toBe('fasting');
  });
});

describe('weigh-ins', () => {
  it('keep one per day, the latest edit winning, and undo back to the earlier one', async () => {
    const { replica, port, intents } = await setup();
    await intents.logWeight(82, today);
    const undo = await intents.logWeight(81.5, today);
    expect((await replica.read.all('weighIn')).map((w) => w.kg)).toEqual([81.5]);
    expect((await bodyView(replica.read, today)).weighIns.map((w) => w.kg)).toEqual([81.5]);
    await undo();
    expect((await replica.read.all('weighIn')).map((w) => w.kg)).toEqual([82]);
    expect(await pushed(port)).toHaveLength(3);
  });

  it('delete and come back on undo', async () => {
    const { replica, intents } = await setup();
    await intents.logWeight(82, today);
    const undo = await intents.deleteWeighIn(today);
    expect((await bodyView(replica.read, today)).trendKg).toBeUndefined();
    await undo();
    expect((await bodyView(replica.read, today)).trendKg).toBe(82);
  });

  it('build a trend and rate over the days, and project the goal weight only once there is enough', async () => {
    const { replica, intents } = await setup();
    await intents.saveGoal({ ...draft, goalWeightKg: 78 }, addDays(today, -30));
    await intents.logWeight(82, addDays(today, -1));
    await intents.logWeight(81.8, today);
    const early = await bodyView(replica.read, today);
    expect(early.trendKg).toBeCloseTo(81.98);
    expect(early.projection).toEqual({ kind: 'not-enough-data' });

    for (let i = 2; i < 21; i++) await intents.logWeight(82 + i * 0.1, addDays(today, -i));
    const later = await bodyView(replica.read, today);
    expect(later.rate.kind).toBe('rate');
    expect(later.goalKg).toBe(78);
    expect(later.projection.kind).toBe('on-course');
  });

  it('move BMR to the trend weight on the day', async () => {
    const { replica, intents } = await setup();
    await intents.saveProfile({ sex: 'male', birthDate: LocalDate.parse('1990-06-15'), heightCm: 180, weightKg: 81 });
    await intents.saveGoal(draft, today);
    expect((await dayView(replica.read, today)).budget?.kcal).toBe(2228);
    await intents.logWeight(91, today);
    const { budget } = await dayView(replica.read, today);
    // BMR 1760 + 10 × 10 kg = 1860. × 1.55 − 500.
    expect(budget?.kcal).toBe(2383);
    expect(budget?.basis).toMatchObject({ kind: 'computed', weight: { kg: 91, source: 'trend' } });
  });
});

describe('workouts', () => {
  const profileAt81 = { sex: 'male', birthDate: LocalDate.parse('1990-06-15'), heightCm: 180, weightKg: 81 } as const;

  it('store the burn at the weight on the day, unchanged by later weigh-ins, and show on the day', async () => {
    const { replica, intents } = await setup();
    await intents.logWeight(80, today);
    await intents.logWorkout(metDraft('run_6', 30), today);
    await intents.logWeight(70, today);
    const { workouts } = await dayView(replica.read, today);
    // 8.8 MET above resting × 80 kg × 0.5 h.
    expect(workouts.map((w) => [w.name, w.kcal, w.kg])).toEqual([['Running, 6 mph (10 min/mi)', 352, 80]]);
  });

  it('count toward the target only under eat-back', async () => {
    const { replica, intents } = await setup();
    await intents.saveProfile(profileAt81);
    await intents.saveGoal({ ...draft, policy: { kind: 'activity-level', level: 'sedentary' } }, today);
    await intents.logWeight(80, today);
    await intents.logWorkout(metDraft('run_6', 30), today);
    // BMR 1750 × 1.2 − 500.
    expect((await dayView(replica.read, today)).budget?.kcal).toBe(1600);

    await intents.saveGoal({ ...draft, policy: { kind: 'eat-back-workouts', fraction: 1 } }, today);
    expect((await dayView(replica.read, today)).budget).toMatchObject({ baseKcal: 1600, workoutKcal: 352, kcal: 1952 });
    expect((await dayView(replica.read, addDays(today, 1))).budget?.workoutKcal).toBe(0);
  });

  it('keep their first weight when edited, and undo the edit and a delete', async () => {
    const { replica, intents } = await setup();
    await intents.logWeight(80, today);
    await intents.logWorkout(metDraft('run_6', 30), today);
    const [run] = (await dayView(replica.read, today)).workouts;
    if (!run) throw new Error('nothing logged');
    await intents.logWeight(100, today);

    const undoEdit = await intents.editWorkout(run.id, { ...metDraft('run_6', 60) });
    expect((await replica.read.get('workout', run.id))?.kcal).toBe(704);
    await undoEdit();
    expect((await replica.read.get('workout', run.id))?.kcal).toBe(352);

    const undoDelete = await intents.deleteWorkout(run.id);
    expect((await dayView(replica.read, today)).workouts).toEqual([]);
    await undoDelete();
    expect((await dayView(replica.read, today)).workouts.map((w) => w.id)).toEqual([run.id]);
  });

  it('fail at the tap, never reaching the outbox, when the burn is more than a workout can store', async () => {
    const { replica, port, intents } = await setup();
    await intents.logWeight(90, today);
    await expect(intents.logWorkout(metDraft('run_10', 1440), today)).rejects.toThrow(InvalidDocument);
    expect((await dayView(replica.read, today)).workouts).toEqual([]);
    expect(await pushed(port)).toEqual([expect.objectContaining({ kg: 90 })]);
  });

  it('wait for a weight before working out a burn, then offer what was logged before', async () => {
    const { replica, intents } = await setup();
    expect(await intents.logWorkout(metDraft('strength', 45), today)).toBeNull();
    expect((await workoutLoggerView(replica.read, today)).weight).toBeUndefined();

    await intents.saveProfile(profileAt81);
    expect((await workoutLoggerView(replica.read, today)).weight).toEqual({ kg: 81, source: 'profile' });
    const undo = await intents.logWorkout(metDraft('strength', 45), today);
    expect(undo).not.toBeNull();
    expect((await workoutLoggerView(replica.read, today)).recents.map((w) => [w.name, w.minutes])).toEqual([['Strength training', 45]]);
  });
});

describe('two phones offline', () => {
  async function phone(name: string, now: () => Millis) {
    const { replica, port } = await openReplica({ name, indexedDB: new IDBFactory(), IDBKeyRange });
    open.push(replica);
    return { replica, port, intents: createIntents(replica, { now, newId: randomUUID }) };
  }

  it('count both drinks, and settle two open fasts with one end', async () => {
    const server = openStore(':memory:');
    const sync = (port: SyncPort) => syncRounds(port, (req) => Promise.resolve(server.sync(req, { now: NOW, userAgent: null })), 50);
    const a = await phone('a', () => NOW);
    const b = await phone('b', () => at(NOW + 60_000));
    try {
      await a.intents.addWater(250, today);
      await b.intents.addWater(250, today);
      await a.intents.startFast(16);
      await b.intents.startFast(16);
      for (const p of [a, b, a]) await sync(p.port);

      expect((await waterView(b.replica.read, today)).totalMl).toBe(500);
      const overlap = (await fastView(b.replica.read, today)).state;
      expect(overlap.kind).toBe('overlap');
      expect(runningFast(overlap)?.startedAt).toBe(NOW);

      await b.intents.endFast();
      for (const p of [b, a]) await sync(p.port);
      const settled = await fastView(a.replica.read, today);
      expect(settled.state).toEqual({ kind: 'idle' });
      expect(settled.history).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('keep one weigh-in for a day both weighed in on, the later arrival winning', async () => {
    const server = openStore(':memory:');
    const sync = (port: SyncPort) => syncRounds(port, (req) => Promise.resolve(server.sync(req, { now: NOW, userAgent: null })), 50);
    const a = await phone('a', () => NOW);
    const b = await phone('b', () => at(NOW + 60_000));
    try {
      await a.intents.logWeight(82, today);
      await b.intents.logWeight(81.6, today);
      await b.intents.logWorkout(metDraft('walk_3', 30), today);
      for (const p of [a, b, a]) await sync(p.port);
      for (const p of [a, b]) {
        expect((await p.replica.read.all('weighIn')).map((w) => w.kg)).toEqual([81.6]);
      }
      expect(await a.intents.logWorkout(metDraft('walk_3', 30), today)).not.toBeNull();
      for (const p of [a, b]) await sync(p.port);
      expect((await dayView(b.replica.read, today)).workouts).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('never reopen a fast one phone ended, nor move its end, when the other changes its target and ends it late', async () => {
    const server = openStore(':memory:');
    const sync = (port: SyncPort) => syncRounds(port, (req) => Promise.resolve(server.sync(req, { now: NOW, userAgent: null })), 50);
    let aNow = NOW;
    const a = await phone('a', () => aNow);
    const b = await phone('b', () => at(NOW + 3 * HOUR_MS));
    try {
      await a.intents.startFast(16);
      for (const p of [a, b]) await sync(p.port);

      aNow = at(NOW + 2 * HOUR_MS);
      await a.intents.endFast();
      await sync(a.port);
      await b.intents.setFastTarget(18);
      await b.intents.endFast();
      for (const p of [b, a, b]) await sync(p.port);

      for (const p of [a, b]) {
        const view = await fastView(p.replica.read, today);
        expect(view.state).toEqual({ kind: 'idle' });
        expect(view.history.map((s) => s.endedAt)).toEqual([at(NOW + 2 * HOUR_MS)]);
      }
    } finally {
      server.close();
    }
  });
});
