import { z } from 'zod';
import { Ingredient, nutrientsFor, snapshotOf, type Food, type FoodSnapshot, type Origin, type Serving } from './food.js';
import { RecipeId, SavedMealId, type FoodId } from './ids.js';
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

/** One serving of a recipe, or of a recipe still being built. */
export function perServing(recipe: { readonly ingredients: readonly Ingredient[]; readonly yield: Pick<RecipeYield, 'servings'> }): Nutrients {
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

/** A food or recipe just saved, whose older snapshots elsewhere may now be stale. */
export type Edited = { readonly kind: 'food'; readonly food: Food } | { readonly kind: 'recipe'; readonly recipe: Recipe };

/** Which food or recipe was edited, by id. */
export type EditedRef = { readonly kind: 'food'; readonly id: FoodId } | { readonly kind: 'recipe'; readonly id: RecipeId };

/** Recipes and saved meals that an edit would update, as they would be after. */
export interface Refresh {
  readonly recipes: readonly Recipe[];
  readonly meals: readonly SavedMeal[];
}

/**
 * What "also update 2 recipes and 1 saved meal?" offers after a food or recipe edit: every
 * live recipe and saved meal holding an older snapshot of it, re-snapshotted. The change
 * carries through recipes held in other recipes and saved meals, so a saved meal of chili
 * updates when the beef in the chili does. Each recipe is worked out once, so recipes that
 * hold each other's older snapshots cannot loop. An item now measured in another unit keeps
 * its snapshot, because its amount would change meaning: 200 g is not 200 portions. Diary
 * entries are never part of it, so past days never change.
 */
export function refreshFor(edited: Edited, uses: { readonly recipes: readonly Recipe[]; readonly meals: readonly SavedMeal[] }): Refresh {
  const live = new Map(uses.recipes.filter((r) => !r.archived).map((r) => [r.id, r]));
  if (edited.kind === 'recipe') live.set(edited.recipe.id, edited.recipe);
  const isEdited = (id: RecipeId) => edited.kind === 'recipe' && edited.recipe.id === id;
  const resolved = new Map<RecipeId, Recipe>();
  const visiting = new Set<RecipeId>();

  /** The snapshot an item of this origin should now hold, or null when this edit does not change it. */
  const freshFor = (origin: Origin): FoodSnapshot | null => {
    switch (origin.kind) {
      case 'adhoc':
        return null;
      case 'food':
        return edited.kind === 'food' && edited.food.id === origin.id ? snapshotOf(edited.food) : null;
      case 'recipe': {
        const recipe = resolve(origin.id);
        return recipe !== undefined && (isEdited(origin.id) || recipe !== live.get(origin.id)) ? recipeSnapshot(recipe) : null;
      }
    }
  };

  const refreshItems = (items: readonly Ingredient[]): Ingredient[] | null => {
    let changed = false;
    const next = items.map((item) => {
      const fresh = freshFor(item.food.origin);
      if (fresh === null || fresh.unit !== item.food.unit || sameSnapshot(item.food, fresh)) return item;
      changed = true;
      return { ...item, food: fresh };
    });
    return changed ? next : null;
  };

  /** The recipe as this edit leaves it. A recipe met again while it is being worked out is taken as it was. */
  function resolve(id: RecipeId): Recipe | undefined {
    const recipe = live.get(id);
    if (recipe === undefined || isEdited(id) || visiting.has(id)) return recipe;
    const known = resolved.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    const ingredients = refreshItems(recipe.ingredients);
    visiting.delete(id);
    const result = ingredients === null ? recipe : { ...recipe, ingredients };
    resolved.set(id, result);
    return result;
  }

  return {
    recipes: [...live.keys()].flatMap((id) => {
      const recipe = resolve(id);
      return recipe === undefined || recipe === live.get(id) ? [] : [recipe];
    }),
    meals: uses.meals.flatMap((meal) => {
      const items = meal.archived ? null : refreshItems(meal.items);
      return items === null ? [] : [{ ...meal, items }];
    }),
  };
}
