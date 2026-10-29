import { describe, expect, it } from 'vitest';
import { makeEntry, summarizeDay, type Entry, type Meal } from '../src/domain/diary.js';
import { FdcId, Gtin, quickAddItem, snapshotOf, type Food, type Quantity, type SearchHit } from '../src/domain/food.js';
import { EntryId, FoodId, LocalDate, Millis } from '../src/domain/ids.js';
import { inLibrary, libraryRefs, rankByName, recents, searchLocal, type Library } from '../src/domain/library.js';
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

const named = (...names: string[]) => names.map((name) => ({ candidate: { name } }));
const ranked = (query: string, ...names: string[]) => rankByName(named(...names), query).map((h) => h.candidate.name);

describe('rankByName', () => {
  it('puts the plain food above longer variants of it', () => {
    expect(ranked('banana', 'Bananas, dehydrated, or banana powder', 'Bananas, raw', 'Bananas, overripe, raw')).toEqual([
      'Bananas, raw',
      'Bananas, overripe, raw',
      'Bananas, dehydrated, or banana powder',
    ]);
  });

  it('prefers a name that leads with the query over one that only mentions it', () => {
    expect(ranked('banana', 'Melon, banana (Navajo)', 'Bananas, raw')).toEqual(['Bananas, raw', 'Melon, banana (Navajo)']);
  });

  it('puts names that match every query word first', () => {
    expect(ranked('chicken breast', 'Chicken, thigh', 'Lunchmeat, chicken breast, sliced')).toEqual(['Lunchmeat, chicken breast, sliced', 'Chicken, thigh']);
  });

  it('lets a plural query find a singular name', () => {
    expect(ranked('eggs', 'Omelet mix', 'Egg, whole, raw')).toEqual(['Egg, whole, raw', 'Omelet mix']);
  });

  it("keeps the source's order between equal matches", () => {
    expect(ranked('rice', 'Rice, brown', 'Rice, white')).toEqual(['Rice, brown', 'Rice, white']);
  });
});

describe('inLibrary', () => {
  const fdc = FdcId.parse(173944);
  const coke = Gtin.parse('0049000000443');
  const usdaBanana = { ...oats, name: 'Bananas, raw', source: { kind: 'usda' as const, fdcId: fdc } };
  const bottle = { ...creme, barcodes: [coke] };
  const hit = (ref: SearchHit['ref'], barcodes: Gtin[] = []): SearchHit => ({
    ref,
    candidate: { name: 'x', unit: 'g', nutrients: {}, servings: [], barcodes, source: { kind: 'user' } },
  });

  it('knows a USDA food Dylan imported, by its USDA id', () => {
    expect(inLibrary(hit({ kind: 'usda', fdcId: fdc }), libraryRefs([usdaBanana]))).toBe(true);
    expect(inLibrary(hit({ kind: 'usda', fdcId: FdcId.parse(1) }), libraryRefs([usdaBanana]))).toBe(false);
  });

  it('knows a product by barcode, whether the hit is keyed by barcode or carries it', () => {
    const refs = libraryRefs([bottle]);
    expect(inLibrary(hit({ kind: 'gtin', gtin: coke }), refs)).toBe(true);
    expect(inLibrary(hit({ kind: 'usda', fdcId: fdc }, [coke]), refs)).toBe(true);
  });

  it('forgets archived foods, so their products can be found again', () => {
    expect(inLibrary(hit({ kind: 'gtin', gtin: coke }), libraryRefs([{ ...bottle, archived: true }]))).toBe(false);
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
