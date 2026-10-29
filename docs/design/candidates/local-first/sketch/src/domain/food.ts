import { z } from 'zod';
import { todo } from '../todo.js';
import { FoodId, Gtin, Millis, RecipeId, SavedMealId } from './ids.js';
import { Nutrients } from './nutrients.js';

/**
 * The unit a food is measured in. 'portion' is for things with no known gram weight
 * (an AI-estimated plate, a restaurant item, a recipe without a cooked weight).
 */
export const FoodUnit = z.enum(['g', 'ml', 'portion']);
export type FoodUnit = z.infer<typeof FoodUnit>;

/** A named serving whose amount is in the owning food's unit ("1 large egg" = 50 g). */
export const Serving = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  amount: z.number().positive(),
});
export type Serving = z.infer<typeof Serving>;

/**
 * How much was eaten. A serving quantity carries a copy of the Serving, amount included,
 * so a quantity never needs a lookup to resolve and cannot dangle. An entry with no
 * quantity basis is unrepresentable.
 */
export const Quantity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), amount: z.number().positive() }),
  z.object({ kind: z.literal('serving'), serving: Serving, count: z.number().positive() }),
]);
export type Quantity = z.infer<typeof Quantity>;

/** Provenance of a snapshot. Used for "recent foods" grouping and for re-snapshot offers. Never read by nutrient math. */
export const Origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('food'), id: FoodId }),
  z.object({ kind: z.literal('recipe'), id: RecipeId }),
  z.object({ kind: z.literal('adhoc') }),
]);
export type Origin = z.infer<typeof Origin>;

/**
 * The self-contained nutritional description of a food at one moment. Entries, recipe
 * ingredients and saved-meal items hold one by value.
 *
 * Canonical basis: `nutrients` describe `per` units of `unit`. External g/ml data is
 * normalized to per = 100. Portion foods use per = 1. One formula (nutrientsFor) covers all.
 */
export const FoodSnapshot = z.object({
  name: z.string().min(1),
  brand: z.string().optional(),
  unit: FoodUnit,
  per: z.number().positive(),
  nutrients: Nutrients,
  servings: z.array(Serving),
  origin: Origin,
});
export type FoodSnapshot = z.infer<typeof FoodSnapshot>;

/** Where a library food came from. Parsed into this shape at the adapter boundary. */
export const FoodSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('off'), gtin: Gtin, fetchedAt: Millis }),
  z.object({ kind: z.literal('usda'), fdcId: z.number().int().positive() }),
  z.object({ kind: z.literal('ai'), from: z.enum(['label', 'plate', 'text']) }),
]);
export type FoodSource = z.infer<typeof FoodSource>;

/** A food in Dylan's library. Synced doc kind 'food'. Never hard-deleted, only archived, so provenance links stay meaningful. */
export const Food = FoodSnapshot.omit({ origin: true }).extend({
  id: FoodId,
  barcodes: z.array(Gtin),
  source: FoodSource,
  archived: z.boolean(),
});
export type Food = z.infer<typeof Food>;

/** An external or AI-produced food not yet in the library. The client imports it on first log or save. */
export const FoodCandidate = Food.omit({ id: true, archived: true });
export type FoodCandidate = z.infer<typeof FoodCandidate>;

/** A food plus how much of it. The shared shape of entry items, recipe ingredients, saved-meal items and AI drafts. */
export const Ingredient = z.object({ food: FoodSnapshot, quantity: Quantity });
export type Ingredient = z.infer<typeof Ingredient>;

/**
 * A recipe yields N servings. Ingredients are values (snapshots), so a recipe cannot
 * reference itself, cannot form a cycle, and any replica can compute it with no other
 * document present. Edits to ingredient foods reach a recipe only through an explicit
 * re-snapshot (see client/intents.ts refreshFromLibrary).
 */
export const Recipe = z.object({
  id: RecipeId,
  name: z.string().min(1),
  ingredients: z.array(Ingredient).min(1),
  yields: z.object({
    servings: z.number().positive(),
    /** Known cooked weight lets Dylan log a recipe by grams. */
    cookedGrams: z.number().positive().optional(),
  }),
  archived: z.boolean(),
});
export type Recipe = z.infer<typeof Recipe>;

/** "Usual breakfast": a bundle of items logged in one tap. Same value semantics as recipes. */
export const SavedMeal = z.object({
  id: SavedMealId,
  name: z.string().min(1),
  items: z.array(Ingredient).min(1),
  archived: z.boolean(),
});
export type SavedMeal = z.infer<typeof SavedMeal>;

/** A food in an external database, by its key there. */
export const ExternalRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gtin'), gtin: Gtin }),
  z.object({ kind: z.literal('usda'), fdcId: z.number().int().positive() }),
]);
export type ExternalRef = z.infer<typeof ExternalRef>;

/** One external search result. complete is false when the source's search payload lacks portions. */
export const SearchHit = z.object({ ref: ExternalRef, candidate: FoodCandidate, complete: z.boolean() });
export type SearchHit = z.infer<typeof SearchHit>;

/** A proposed diary item from AI quick log. Nothing is written until Dylan confirms on the phone. */
export const Draft = z.object({
  item: Ingredient,
  match: z.discriminatedUnion('kind', [
    /** Matched a library food; item.food is that food's current snapshot. */
    z.object({ kind: z.literal('library'), foodId: FoodId }),
    z.object({ kind: z.literal('estimate'), confidence: z.enum(['low', 'medium', 'high']) }),
  ]),
  note: z.string().optional(),
});
export type Draft = z.infer<typeof Draft>;

/** What AI quick log returns: diary drafts (text, plate photo), a food to save (label photo), or a reason it could not read the input. */
export const AiResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drafts'), drafts: z.array(Draft) }),
  z.object({ kind: z.literal('label'), candidate: FoodCandidate }),
  z.object({ kind: z.literal('unreadable'), reason: z.string() }),
]);
export type AiResult = z.infer<typeof AiResult>;

/** Base amount (in the food's unit) of a quantity. */
export function baseAmount(q: Quantity): number {
  return todo(`baseAmount(${q.kind})`);
}

/**
 * The only food-times-quantity formula in the system:
 * scale(food.nutrients, baseAmount(q) / food.per).
 */
export function nutrientsFor(food: FoodSnapshot, q: Quantity): Nutrients {
  return todo(`nutrientsFor(${food.name}, ${q.kind})`);
}

export function snapshotOf(food: Food): FoodSnapshot {
  return todo(`snapshotOf(${food.id})`);
}

/** First named serving times 1, else 100 g/ml, else 1 portion. */
export function defaultQuantity(food: FoodSnapshot): Quantity {
  return todo(`defaultQuantity(${food.name})`);
}

export function importCandidate(candidate: FoodCandidate, id: FoodId): Food {
  return todo(`importCandidate(${candidate.name}, ${id})`);
}

/** A one-off food for quick add ("300 kcal, restaurant"). unit 'portion', per 1, origin adhoc. */
export function quickAddSnapshot(label: string, nutrients: Nutrients): FoodSnapshot {
  return todo(`quickAddSnapshot(${label}, ${nutrients.kcal})`);
}

/**
 * A recipe as a loggable food. With cookedGrams: unit g, per 100, a "1 serving" serving of
 * cookedGrams / servings. Without: unit portion, per 1, nutrients = recipe total / servings.
 * A nutrient appears if any ingredient reports it (missing counts as 0, same rule as Totals).
 */
export function recipeAsSnapshot(recipe: Recipe): FoodSnapshot {
  return todo(`recipeAsSnapshot(${recipe.id})`);
}
