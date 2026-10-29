import { describe, expect, it } from 'vitest';
import { makeEntry, summarizeDay, type Entry, type Meal } from '../src/domain/diary.js';
import { quickAddItem, snapshotOf, type Food, type Quantity } from '../src/domain/food.js';
import { EntryId, FoodId, LocalDate, Millis } from '../src/domain/ids.js';
import { recents, searchLocal, type Library } from '../src/domain/library.js';
import { food, newEntryId } from './fixtures.js';

const DAY = 86_400_000;
const NOW = Millis.parse(1_800_000_000_000);
const date = LocalDate.parse('2026-10-28');

function log(f: Food, quantity: Quantity, daysAgo: number, meal: Meal = 'breakfast'): Entry {
  return makeEntry({ food: snapshotOf(f), quantity }, { date, meal }, newEntryId(), Millis.parse(NOW - daysAgo * DAY));
}

const oats = { ...food(FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100')), name: 'Rolled oats' };
const creme = { ...food(FoodId.parse('1f1e1d1c-1b1a-4918-9716-151413121110')), name: 'Crème fraîche', brand: 'Président' };
const grams = (amount: number): Quantity => ({ kind: 'amount', amount });
const library = (...foods: Food[]): Library => ({ foods, recipes: [] });

describe('recents', () => {
  it('offers each food once, with the quantity and meal of its latest use', () => {
    const entries = [log(oats, grams(40), 3), log(oats, grams(60), 1, 'snacks')];
    const [only, ...rest] = recents({ entries, library: library(oats), now: NOW, limit: 10 });
    expect(rest).toEqual([]);
    expect(only?.lastQuantity).toEqual(grams(60));
    expect(only?.lastMeal).toBe('snacks');
  });

  it('ranks a daily staple above a one-off from yesterday', () => {
    const entries = [log(creme, grams(30), 1), ...[2, 3, 4, 5].map((d) => log(oats, grams(40), d))];
    expect(recents({ entries, library: library(oats, creme), now: NOW, limit: 10 }).map((r) => r.food.name)).toEqual(['Rolled oats', 'Crème fraîche']);
  });

  it('offers the library food as it is now, and drops it once archived', () => {
    const entries = [log(oats, grams(40), 1)];
    const edited = { ...oats, nutrients: { ...oats.nutrients, kcal: 370 } };
    expect(recents({ entries, library: library(edited), now: NOW, limit: 10 })[0]?.food.nutrients.kcal).toBe(370);
    expect(recents({ entries, library: library({ ...oats, archived: true }), now: NOW, limit: 10 })).toEqual([]);
  });

  it('groups one-off quick adds by name', () => {
    const quick = (label: string, kcal: number, daysAgo: number) =>
      makeEntry(quickAddItem(label, { kcal }), { date, meal: 'dinner' }, EntryId.parse(crypto.randomUUID()), Millis.parse(NOW - daysAgo * DAY));
    const result = recents({ entries: [quick('Burrito', 900, 2), quick('burrito', 950, 1)], library: library(), now: NOW, limit: 10 });
    expect(result.map((r) => r.food.nutrients.kcal)).toEqual([950]);
  });
});

describe('searchLocal', () => {
  const recent = recents({ entries: [log(creme, grams(30), 1)], library: library(oats, creme), now: NOW, limit: 50 });

  it('matches word prefixes of the name or brand, ignoring case and accents', () => {
    const names = (query: string) => searchLocal({ query, library: library(oats, creme), recents: recent, limit: 10 }).map((h) => h.food.name);
    expect(names('creme')).toEqual(['Crème fraîche']);
    expect(names('presi')).toEqual(['Crème fraîche']);
    expect(names('oat roll')).toEqual(['Rolled oats']);
    expect(names('ats')).toEqual([]);
  });

  it('lists recent foods first with their last quantity, then library foods, never archived ones', () => {
    const hits = searchLocal({ query: '', library: library(oats, creme, { ...food(), name: 'Old bar', archived: true }), recents: recent, limit: 10 });
    expect(hits.map((h) => [h.food.name, h.lastQuantity])).toEqual([
      ['Crème fraîche', grams(30)],
      ['Rolled oats', undefined],
    ]);
  });
});

describe('summarizeDay', () => {
  it('totals each meal and the day, keeping unknown macros visible', () => {
    const breakfast = log(oats, grams(50), 0);
    const dinner = makeEntry(quickAddItem('Pizza', { kcal: 800 }), { date, meal: 'dinner' }, newEntryId(), NOW);
    const day = summarizeDay([dinner, breakfast]);
    expect(day.meals.breakfast.totals.sum.kcal).toBe(190);
    expect(day.meals.breakfast.totals.incomplete.has('protein')).toBe(false);
    expect(day.meals.dinner.totals.incomplete.has('protein')).toBe(true);
    expect(day.meals.lunch.entries).toEqual([]);
    expect(day.totals.sum.kcal).toBe(990);
    expect(day.totals.sum.protein).toBe(6.5);
  });
});
