import { describe, expect, it } from 'vitest';
import { makeEntry } from '../src/domain/diary.js';
import { nutrientsFor, snapshotOf, type Food, type Quantity } from '../src/domain/food.js';
import { FoodId, LocalDate, Millis } from '../src/domain/ids.js';
import { recents, type Library } from '../src/domain/library.js';
import { choicesFor, draftItem, estimateItem, foodHints, type Draft, type DraftAmount } from '../src/domain/quicklog.js';
import { food, newEntryId } from './fixtures.js';

const NOW = Millis.parse(1_800_000_000_000);
const date = LocalDate.parse('2026-10-28');

const oats: Food = { ...food(FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100')), name: 'Overnight oats', servings: [{ label: '1 jar', amount: 250 }] };
const egg: Food = {
  ...food(FoodId.parse('1f1e1d1c-1b1a-4918-9716-151413121110')),
  name: 'Egg',
  brand: 'Vital Farms',
  nutrients: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 },
  servings: [{ label: '1 large egg', amount: 50 }],
};
const milk: Food = { ...food(FoodId.parse('2f2e2d2c-2b2a-4928-a726-252423222120')), name: 'Oat milk', unit: 'ml', servings: [] };
const library: Library = { foods: [oats, egg, milk], recipes: [] };
const jar: Quantity = { kind: 'serving', serving: { label: '1 jar', amount: 250 }, count: 1 };
const history = recents({
  entries: [makeEntry({ food: snapshotOf(oats), quantity: jar }, { date, meal: 'breakfast' }, newEntryId(), NOW)],
  library,
  now: NOW,
  limit: 10,
});

const none: DraftAmount = { described: '', count: null, countUnit: null, grams: null, ml: null };
function draft(name: string, amount: Partial<DraftAmount>, kcal: number, match: string | null = null): Draft {
  return { name, amount: { ...none, ...amount }, nutrients: { kcal, protein: 10, carbs: 20, fat: 5 }, confidence: 'medium', match };
}
const choose = (d: Draft) => choicesFor(d, { recents: history, library });
const kcalOf = (d: Draft, pick: 'first' | 'estimate') => {
  const item = draftItem(d, pick === 'first' ? (choose(d)[0] ?? null) : null);
  return nutrientsFor(item.food, item.quantity).kcal;
};

describe('foodHints', () => {
  it('lists what he logs first, then the rest of the library, each once and within the limit', () => {
    const hints = foodHints({ recents: history, library, limit: 10 });
    expect(hints.map((h) => h.name)).toEqual(['Overnight oats', 'Egg', 'Oat milk']);
    expect(hints[1]).toEqual({ key: `food:${egg.id}`, name: 'Egg', brand: 'Vital Farms' });
    expect(foodHints({ recents: history, library, limit: 2 })).toHaveLength(2);
  });
});

describe('choicesFor', () => {
  it("puts the model's match first, then foods the draft's name finds", () => {
    const names = (d: Draft) => choose(d).map((c) => c.food.name);
    expect(names(draft('Porridge', {}, 300, `food:${oats.id}`))).toEqual(['Overnight oats']);
    expect(names(draft('Oat', {}, 100))).toEqual(['Overnight oats', 'Oat milk']);
    expect(names(draft('Oat', {}, 100, `food:${milk.id}`))).toEqual(['Oat milk', 'Overnight oats']);
  });

  it('offers nothing when no food of his fits, and ignores a key he does not have', () => {
    expect(choose(draft('Croissant', {}, 400))).toEqual([]);
    expect(choose(draft('Croissant', {}, 400, 'food:not-his'))).toEqual([]);
  });
});

describe('a draft logged as one of his foods', () => {
  it('logs his usual amount and his own nutrients when no amount was said', () => {
    const usual = draft('Oats', {}, 999, `food:${oats.id}`);
    const item = draftItem(usual, choose(usual)[0] ?? null);
    expect(item.quantity).toEqual(jar);
    expect(nutrientsFor(item.food, item.quantity).kcal).toBeCloseTo(380 * 2.5);
  });

  it('counts his servings when the count agrees with the weight, and logs the weight when it does not', () => {
    const eggs = draft('Egg', { count: 2, countUnit: 'egg', grams: 100 }, 155, `food:${egg.id}`);
    expect(draftItem(eggs, choose(eggs)[0] ?? null).quantity).toEqual({ kind: 'serving', serving: { label: '1 large egg', amount: 50 }, count: 2 });
    expect(kcalOf(eggs, 'first')).toBeCloseTo(143);

    const bowl = draft('Oats', { count: 1, countUnit: 'bowl', grams: 80 }, 300, `food:${oats.id}`);
    expect(draftItem(bowl, choose(bowl)[0] ?? null).quantity).toEqual({ kind: 'amount', amount: 80 });
  });

  it('never turns millilitres into grams', () => {
    const shake = draft('Oats', { ml: 300 }, 250, `food:${oats.id}`);
    expect(draftItem(shake, choose(shake)[0] ?? null).quantity).toEqual(jar);
    const latte = draft('Oat milk', { ml: 300 }, 150, `food:${milk.id}`);
    expect(draftItem(latte, choose(latte)[0] ?? null).quantity).toEqual({ kind: 'amount', amount: 300 });
  });
});

describe('a draft logged as the estimate', () => {
  it("logs the model's totals, by weight, with a counted piece to change the count by", () => {
    const pizza = draft('Pepperoni pizza', { described: '2 slices', count: 2, countUnit: 'slice', grams: 220 }, 570);
    const item = estimateItem(pizza);
    expect(item.food).toMatchObject({ unit: 'g', servings: [{ label: '1 slice', amount: 110 }], origin: { kind: 'adhoc' } });
    expect(nutrientsFor(item.food, item.quantity)).toMatchObject({ kcal: 570, protein: 10, carbs: 20, fat: 5 });
    expect(nutrientsFor(item.food, { kind: 'serving', serving: { label: '1 slice', amount: 110 }, count: 1 }).kcal).toBeCloseTo(285);
  });

  it('measures a drink in millilitres and an unweighed dish in portions', () => {
    expect(estimateItem(draft('Flat white', { ml: 240 }, 120)).food.unit).toBe('ml');
    const curry = estimateItem(draft('Chicken curry', { count: 2 }, 900));
    expect(curry.food.unit).toBe('portion');
    expect(curry.food.nutrients.kcal).toBe(450);
    expect(nutrientsFor(curry.food, curry.quantity).kcal).toBe(900);
  });

  it('keeps an optional nutrient the model gave and leaves the rest unknown', () => {
    const item = estimateItem({ ...draft('Apple', { grams: 180 }, 95), nutrients: { kcal: 95, protein: 0.5, carbs: 25, fat: 0.3, fiber: 4.4 } });
    const totals = nutrientsFor(item.food, item.quantity);
    expect(totals.fiber).toBeCloseTo(4.4);
    expect(totals.sugar).toBeUndefined();
  });
});
