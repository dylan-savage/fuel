import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeEntry } from '../src/domain/diary.js';
import { Gtin, nutrientsFor, snapshotOf, type Food, type Ingredient } from '../src/domain/food.js';
import { FoodId, LocalDate, Millis, RecipeId, SavedMealId } from '../src/domain/ids.js';
import { recents } from '../src/domain/library.js';
import { perServing, recipeSnapshot, refreshFor, type Recipe, type SavedMeal } from '../src/domain/reuse.js';
import { newEntryId } from './fixtures.js';

const NOW = Millis.parse(1_800_000_000_000);

function libraryFood(name: string, nutrients: Food['nutrients']): Food {
  return { id: FoodId.parse(randomUUID()), name, unit: 'g', nutrients, servings: [], barcodes: [], source: { kind: 'user' }, archived: false };
}

const beef = libraryFood('Ground beef', { kcal: 250, protein: 26, carbs: 0, fat: 15 });
const beans = libraryFood('Kidney beans', { kcal: 127, protein: 8.7, carbs: 22.8, fat: 0.5, fiber: 6.4 });
const grams = (food: Food, amount: number): Ingredient => ({ food: snapshotOf(food), quantity: { kind: 'amount', amount } });

function chili(cookedGrams?: number): Recipe {
  return {
    id: RecipeId.parse(randomUUID()),
    name: 'Chili',
    ingredients: [grams(beef, 500), grams(beans, 400)],
    yield: cookedGrams === undefined ? { servings: 4 } : { servings: 4, cookedGrams },
    archived: false,
  };
}

describe('recipe nutrients', () => {
  it('derives one serving from the whole pot', () => {
    // 500 g beef + 400 g beans = 1758 kcal, 164.8 g protein, 91.2 g carbs, 77 g fat, in 4 servings.
    const serving = perServing(chili());
    expect(serving.kcal).toBeCloseTo(439.5);
    expect(serving.protein).toBeCloseTo(41.2);
    expect(serving.carbs).toBeCloseTo(22.8);
    expect(serving.fat).toBeCloseTo(19.25);
  });

  it('leaves a nutrient unknown when any ingredient does not report it, and knows it once all do', () => {
    expect(perServing(chili()).fiber).toBeUndefined();
    const withFiber = { ...chili(), ingredients: [grams({ ...beef, nutrients: { ...beef.nutrients, fiber: 0 } }, 500), grams(beans, 400)] };
    expect(perServing(withFiber).fiber).toBeCloseTo(6.4);
  });

  it('logs by the serving or by portions when there is no cooked weight', () => {
    const snapshot = recipeSnapshot(chili());
    expect(snapshot.unit).toBe('portion');
    expect(snapshot.origin.kind).toBe('recipe');
    const [serving] = snapshot.servings;
    if (!serving) throw new Error('no serving');
    expect(nutrientsFor(snapshot, { kind: 'serving', serving, count: 1 }).kcal).toBeCloseTo(439.5);
    expect(nutrientsFor(snapshot, { kind: 'amount', amount: 2 }).kcal).toBeCloseTo(879);
  });

  it('logs by grams of the cooked dish when the cooked weight is known', () => {
    const snapshot = recipeSnapshot(chili(1600));
    expect(snapshot.unit).toBe('g');
    expect(snapshot.servings).toEqual([{ label: '1 serving', amount: 400 }]);
    expect(nutrientsFor(snapshot, { kind: 'amount', amount: 200 }).kcal).toBeCloseTo(219.75);
    expect(nutrientsFor(snapshot, { kind: 'amount', amount: 400 }).protein).toBeCloseTo(41.2);
    expect(nutrientsFor(snapshot, { kind: 'amount', amount: 400 }).fiber).toBeUndefined();
  });
});

describe('recipes in recents', () => {
  const logged = (recipe: Recipe, quantity: Ingredient['quantity']) =>
    makeEntry({ food: recipeSnapshot(recipe), quantity }, { date: LocalDate.parse('2026-10-28'), meal: 'dinner' }, newEntryId(), NOW);

  it('offer the recipe as it is now, and drop it once archived', () => {
    const recipe = chili();
    const entries = [logged(recipe, { kind: 'amount', amount: 1 })];
    const renamed = { ...recipe, name: 'Texas chili' };
    expect(recents({ entries, library: { foods: [], recipes: [renamed] }, now: NOW, limit: 5 }).map((r) => r.food.name)).toEqual(['Texas chili']);
    expect(recents({ entries, library: { foods: [], recipes: [{ ...recipe, archived: true }] }, now: NOW, limit: 5 })).toEqual([]);
  });

  it('start from one serving once a cooked weight changes the unit, instead of 1 g', () => {
    const recipe = chili();
    const entries = [logged(recipe, { kind: 'amount', amount: 1 })];
    const [recent] = recents({ entries, library: { foods: [], recipes: [{ ...recipe, yield: { servings: 4, cookedGrams: 1600 } }] }, now: NOW, limit: 5 });
    expect(recent?.lastQuantity).toEqual({ kind: 'serving', serving: { label: '1 serving', amount: 400 }, count: 1 });
  });
});

describe('refreshFor', () => {
  const leaner = { ...beef, nutrients: { kcal: 200, protein: 28, carbs: 0, fat: 10 } };
  const breakfast: SavedMeal = { id: SavedMealId.parse(randomUUID()), name: 'Steak and beans', items: [grams(beef, 150), grams(beans, 100)], archived: false };

  it('offers every live recipe and saved meal holding an older snapshot of the food, re-snapshotted', () => {
    const recipe = chili();
    const other = { ...chili(), ingredients: [grams(beans, 400)] };
    const gone = { ...chili(), archived: true };
    const { recipes, meals } = refreshFor({ kind: 'food', food: leaner }, { recipes: [recipe, other, gone], meals: [breakfast] });
    expect(recipes.map((r) => r.id)).toEqual([recipe.id]);
    expect(recipes[0]?.ingredients.map((i) => i.food.nutrients.kcal)).toEqual([200, 127]);
    expect(recipes[0]?.ingredients.map((i) => i.quantity)).toEqual(recipe.ingredients.map((i) => i.quantity));
    expect(meals[0]?.items[0]?.food.nutrients.kcal).toBe(200);
  });

  it('offers nothing when the edit leaves the snapshot as it was, such as adding a barcode', () => {
    const barcodeOnly = { ...beef, barcodes: [Gtin.parse('0049000000443')] };
    expect(refreshFor({ kind: 'food', food: barcodeOnly }, { recipes: [chili()], meals: [breakfast] })).toEqual({ recipes: [], meals: [] });
  });

  it('keeps an item measured in another unit, since its amount would change meaning', () => {
    const asPortion = { ...leaner, unit: 'portion' as const };
    expect(refreshFor({ kind: 'food', food: asPortion }, { recipes: [chili()], meals: [] }).recipes).toEqual([]);
  });

  const serving = (recipe: Recipe): Ingredient => {
    const food = recipeSnapshot(recipe);
    const [one] = food.servings;
    if (one === undefined) throw new Error('a recipe has a serving');
    return { food, quantity: { kind: 'serving', serving: one, count: 1 } };
  };

  it('carries a food edit through a recipe into the saved meals and recipes that hold that recipe', () => {
    const recipe = chili();
    const night: SavedMeal = { id: SavedMealId.parse(randomUUID()), name: 'Chili night', items: [serving(recipe)], archived: false };
    const bowl: Recipe = { ...chili(), name: 'Chili bowl', ingredients: [{ ...serving(recipe), quantity: { kind: 'amount', amount: 2 } }, grams(beans, 100)] };
    const { recipes, meals } = refreshFor({ kind: 'food', food: leaner }, { recipes: [recipe, bowl], meals: [night] });
    // 500 g at 200 kcal + 400 g beans at 127 kcal, in 4 servings.
    expect(meals[0]?.items[0]?.food.nutrients.kcal).toBeCloseTo((1000 + 508) / 4);
    expect(recipes.find((r) => r.id === bowl.id)?.ingredients[0]?.food.nutrients.kcal).toBeCloseTo((1000 + 508) / 4);
  });

  it('offers the same update after a recipe edit, keeping items whose unit the edit changed', () => {
    const recipe = chili();
    const night: SavedMeal = { id: SavedMealId.parse(randomUUID()), name: 'Chili night', items: [serving(recipe)], archived: false };
    const fewer = { ...recipe, yield: { servings: 3 } };
    expect(refreshFor({ kind: 'recipe', recipe: fewer }, { recipes: [fewer], meals: [night] }).meals[0]?.items[0]?.food.nutrients.kcal).toBeCloseTo(1758 / 3);
    const weighed = { ...recipe, yield: { servings: 4, cookedGrams: 1600 } };
    expect(refreshFor({ kind: 'recipe', recipe: weighed }, { recipes: [weighed], meals: [night] })).toEqual({ recipes: [], meals: [] });
  });

  it('ends when two recipes hold older snapshots of each other', () => {
    const a = chili();
    const b: Recipe = { ...chili(), name: 'Chili mac', ingredients: [serving(a), grams(beef, 100)] };
    const aWithB: Recipe = { ...a, ingredients: [...a.ingredients, serving(b)] };
    const { recipes } = refreshFor({ kind: 'food', food: leaner }, { recipes: [aWithB, b], meals: [] });
    expect(recipes.map((r) => r.name).toSorted()).toEqual(['Chili', 'Chili mac']);
  });
});
