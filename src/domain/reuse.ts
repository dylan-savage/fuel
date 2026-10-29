import { z } from 'zod';
import { Ingredient, nutrientsFor, snapshotOf, type Food, type FoodSnapshot, type Serving } from './food.js';
import { RecipeId, SavedMealId } from './ids.js';
import { NUTRIENTS, combine, scale, type Nutrients } from './nutrients.js';
import { BASIS } from './units.js';

/** How much a recipe makes. With the cooked weight known, a serving can be logged by grams. */
export const RecipeYield = z.looseObject({
  servings: z.number().positive(),
  cookedGrams: z.number().positive().optional(),
});
export type RecipeYield = z.infer<typeof RecipeYield>;

/**
 * A dish made from foods. Ingredients hold snapshots by value, so a recipe can never contain
 * itself, and an edited food reaches it only when Dylan accepts the update prompt. Archived,
 * never deleted, so recents can tell it is gone. Synced document kind 'recipe'.
 */
export const Recipe = z.looseObject({
  id: RecipeId,
  name: z.string().min(1),
  ingredients: z.array(Ingredient).min(1),
  yield: RecipeYield,
  archived: z.boolean(),
});
export type Recipe = z.infer<typeof Recipe>;

/** What the recipe builder produces; the id and archived flag belong to the library. */
export const RecipeDraft = Recipe.omit({ id: true, archived: true });
export type RecipeDraft = z.infer<typeof RecipeDraft>;

/** "Usual breakfast": items logged together in one tap, into any meal. Synced document kind 'savedMeal'. */
export const SavedMeal = z.looseObject({
  id: SavedMealId,
  name: z.string().min(1),
  items: z.array(Ingredient).min(1),
  archived: z.boolean(),
});
export type SavedMeal = z.infer<typeof SavedMeal>;

export const SavedMealDraft = SavedMeal.omit({ id: true, archived: true });
export type SavedMealDraft = z.infer<typeof SavedMealDraft>;

/** The items eaten together. A nutrient is known only when every item reports it. */
export function itemsNutrients(items: readonly Ingredient[]): Nutrients {
  return combine(items.map((item) => nutrientsFor(item.food, item.quantity)));
}

/** One serving of a recipe, or of a draft that has no id yet. */
export function perServing(recipe: Pick<Recipe, 'ingredients' | 'yield'>): Nutrients {
  return scale(itemsNutrients(recipe.ingredients), 1 / recipe.yield.servings);
}

/**
 * A recipe as something to log. With a cooked weight it is measured in grams of the cooked
 * dish, and one serving is that weight shared by the servings. Without one it is measured in
 * portions, one portion being one serving.
 */
export function recipeSnapshot(recipe: Recipe): FoodSnapshot {
  const { servings, cookedGrams } = recipe.yield;
  const origin = { kind: 'recipe', id: recipe.id } as const;
  if (cookedGrams === undefined) {
    return { name: recipe.name, unit: 'portion', nutrients: perServing(recipe), servings: [{ label: '1 serving', amount: 1 }], origin };
  }
  const per100g = scale(itemsNutrients(recipe.ingredients), BASIS.g / cookedGrams);
  return { name: recipe.name, unit: 'g', nutrients: per100g, servings: [{ label: '1 serving', amount: cookedGrams / servings }], origin };
}

const sameServings = (a: readonly Serving[], b: readonly Serving[]) =>
  a.length === b.length && a.every((s, i) => s.label === b[i]?.label && s.amount === b[i]?.amount);

/** Two snapshots log the same when name, brand, unit, servings and every nutrient agree. */
export function sameSnapshot(a: FoodSnapshot, b: FoodSnapshot): boolean {
  return (
    a.name === b.name &&
    a.brand === b.brand &&
    a.unit === b.unit &&
    sameServings(a.servings, b.servings) &&
    NUTRIENTS.every(({ key }) => a.nutrients[key] === b.nutrients[key])
  );
}

/**
 * The items with the food's current snapshot, or null when none would change. An item of the
 * food measured in another unit keeps its snapshot, because its amount would change meaning:
 * 200 g is not 200 portions.
 */
function refreshItems(items: readonly Ingredient[], food: Food): Ingredient[] | null {
  const fresh = snapshotOf(food);
  let changed = false;
  const next = items.map((item) => {
    const { origin } = item.food;
    if (origin.kind !== 'food' || origin.id !== food.id || item.food.unit !== food.unit || sameSnapshot(item.food, fresh)) return item;
    changed = true;
    return { ...item, food: fresh };
  });
  return changed ? next : null;
}

/** Recipes and saved meals that an edited food would update, as they would be after. */
export interface Refresh {
  readonly recipes: readonly Recipe[];
  readonly meals: readonly SavedMeal[];
}

/**
 * What "also update 2 recipes and 1 saved meal?" offers after a food edit: the live recipes
 * and saved meals holding an older snapshot of the food, re-snapshotted. Diary entries are
 * never part of it, so past days never change.
 */
export function refreshFor(food: Food, uses: { readonly recipes: readonly Recipe[]; readonly meals: readonly SavedMeal[] }): Refresh {
  return {
    recipes: uses.recipes.flatMap((recipe) => {
      const ingredients = recipe.archived ? null : refreshItems(recipe.ingredients, food);
      return ingredients === null ? [] : [{ ...recipe, ingredients }];
    }),
    meals: uses.meals.flatMap((meal) => {
      const items = meal.archived ? null : refreshItems(meal.items, food);
      return items === null ? [] : [{ ...meal, items }];
    }),
  };
}
