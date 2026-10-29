/**
 * Every user action that changes data. Each intent reads what it needs from the replica,
 * builds whole documents with pure domain functions, and makes exactly one commit, so a
 * multi-doc action (import a food and log it, log a saved meal) is atomic locally and
 * travels as consecutive mutations. Screens build Ingredients with domain constructors;
 * they never build documents.
 */
import { todo } from '../todo.js';
import type { MetActivityId } from '../domain/burn.js';
import type { Meal, Slot } from '../domain/diary.js';
import type { FoodCandidate, Ingredient, Quantity, Recipe, SavedMeal, Food } from '../domain/food.js';
import type { Goal, Profile } from '../domain/goals.js';
import type {
  EntryId,
  ExerciseId,
  FastId,
  FoodId,
  LocalDate,
  Millis,
  RecipeId,
  SavedMealId,
  WaterId,
} from '../domain/ids.js';
import type { Kg } from '../domain/units.js';
import type { Replica } from './replica.js';

/** Restores what an intent removed or changed. Offered in the undo toast for a few seconds. */
export type Undo = () => Promise<void>;

export interface Intents {
  /**
   * THE way to put food in the diary: one commit, one entry per item, in order. A recent tap,
   * a library food, a recipe (recipeAsSnapshot), a saved meal (its items), quick add
   * (quickAddSnapshot), confirmed AI drafts (draft.item) and "copy yesterday's lunch" (that
   * meal's entries as items) all arrive here as Ingredients. No other intent creates entries
   * except copyDay, which keeps each entry's own meal.
   */
  logItems(items: readonly Ingredient[], slot: Slot): Promise<EntryId[]>;
  /** Imports an external candidate into the library (or reuses the food with that barcode) and logs it, in one commit. */
  logCandidate(candidate: FoodCandidate, quantity: Quantity, slot: Slot): Promise<{ foodId: FoodId; entryId: EntryId }>;
  /** Copies every entry of a day to another day, each keeping its meal. */
  copyDay(from: LocalDate, to: LocalDate): Promise<EntryId[]>;
  editEntry(id: EntryId, patch: { quantity?: Quantity; meal?: Meal; date?: LocalDate }): Promise<Undo>;
  deleteEntry(id: EntryId): Promise<Undo>;

  saveFood(food: Omit<Food, 'id'> & { id?: FoodId }): Promise<FoodId>;
  archiveFood(id: FoodId): Promise<Undo>;
  saveRecipe(recipe: Omit<Recipe, 'id'> & { id?: RecipeId }): Promise<RecipeId>;
  saveMeal(meal: Omit<SavedMeal, 'id'> & { id?: SavedMealId }): Promise<SavedMealId>;
  /**
   * Re-snapshots ingredients whose origin food still exists, after Dylan edits a food and
   * accepts "also update 2 recipes and 1 saved meal?". Returns how many items changed.
   * Diary entries are never re-snapshotted.
   */
  refreshFromLibrary(target: { kind: 'recipe'; id: RecipeId } | { kind: 'savedMeal'; id: SavedMealId }): Promise<number>;

  weigh(kg: Kg, date: LocalDate): Promise<void>;
  addWater(ml: number, date: LocalDate): Promise<WaterId>;
  startFast(targetHours?: number): Promise<FastId>;
  /** Ends every open fast, which also resolves the two-replica overlap state. */
  endFast(): Promise<void>;
  logWorkout(
    input: { kind: 'met'; activity: MetActivityId; minutes: number } | { kind: 'entered'; label: string; kcal: number; minutes: number },
    date: LocalDate,
  ): Promise<ExerciseId>;

  setGoal(goal: Omit<Goal, 'id' | 'effectiveFrom'>, effectiveFrom: LocalDate): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
}

/** Random ids are minted here, on the client, with crypto.randomUUID(). The server never mints them. */
export function createIntents(replica: Replica, now: () => Millis): Intents {
  return todo(`createIntents(${typeof replica}, ${typeof now})`);
}
