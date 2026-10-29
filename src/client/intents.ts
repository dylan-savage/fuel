/**
 * Every user action that changes data. Each intent builds whole documents with pure domain
 * functions and makes exactly one commit. Screens hand in Ingredients and drafts; they never
 * build documents.
 */
import { itemOf, makeEntry, type Entry, type Meal, type Slot } from '../domain/diary.js';
import {
  Food,
  completeFood,
  snapshotOf,
  type Completion,
  type FoodCandidate,
  type FoodDraft,
  type Ingredient,
  type Quantity,
} from '../domain/food.js';
import { Goal, PROFILE_ID, Profile, goalId, type GoalDraft, type ProfileDraft } from '../domain/goals.js';
import { endOpen, fastState, type Fast, type Water } from '../domain/habits.js';
import { EntryId, FastId, FoodId, Millis, RecipeId, SavedMealId, WaterId, type LocalDate } from '../domain/ids.js';
import type { Mutation } from '../domain/kinds.js';
import type { CoreKey } from '../domain/nutrients.js';
import { Recipe, refreshFor, type RecipeDraft, type SavedMeal, type SavedMealDraft } from '../domain/reuse.js';
import type { Replica } from './replica.js';

/** Restores what an intent changed. Offered in the undo toast. */
export type Undo = () => Promise<void>;

export interface Logged {
  readonly ids: readonly EntryId[];
  readonly undo: Undo;
}

export type Imported = { readonly ok: true; readonly logged: Logged } | { readonly ok: false; readonly missing: readonly CoreKey[] };

/** What accepting the food-edit prompt changed. */
export interface UsesUpdated {
  readonly recipes: number;
  readonly meals: number;
  readonly undo: Undo;
}

export interface Intents {
  /**
   * The one way to put food in the diary: one entry per item, in one commit. Recipes, saved
   * meals and copied meals all arrive here as items.
   */
  logItems(items: readonly Ingredient[], slot: Slot): Promise<Logged>;
  /**
   * Copies every entry of one day onto another, each keeping its own meal, in one commit.
   * The only other way entries are made, because each copy keeps its own meal.
   */
  copyDay(from: LocalDate, to: LocalDate): Promise<Logged>;
  /** Changes how much was eaten and in which meal. */
  editEntry(id: EntryId, change: { readonly quantity: Quantity; readonly meal: Meal }): Promise<Undo>;
  deleteEntry(id: EntryId): Promise<Undo>;
  /**
   * Adds a confirmed external food to the library and logs it, in one commit. Refuses, naming
   * the core nutrients, when the candidate is still incomplete.
   */
  importAndLog(candidate: FoodCandidate, quantity: Quantity, slot: Slot): Promise<Imported>;
  createFood(draft: FoodDraft): Promise<Food>;
  updateFood(id: FoodId, draft: FoodDraft): Promise<Food>;
  /** Adds a confirmed external food to the library without logging it, such as a recipe ingredient. */
  importFood(candidate: FoodCandidate): Promise<Completion>;
  /** Foods are archived, never deleted, so entries keep meaningful provenance. */
  archiveFood(id: FoodId): Promise<Undo>;
  /**
   * Gives the recipes and saved meals that use this food its current snapshot, after Dylan
   * accepts the prompt that follows a food edit. Diary entries never change.
   */
  updateUsesOf(id: FoodId): Promise<UsesUpdated>;
  createRecipe(draft: RecipeDraft): Promise<Recipe>;
  updateRecipe(id: RecipeId, draft: RecipeDraft): Promise<Recipe>;
  archiveRecipe(id: RecipeId): Promise<Undo>;
  saveMeal(draft: SavedMealDraft): Promise<SavedMeal>;
  archiveMeal(id: SavedMealId): Promise<Undo>;
  saveProfile(draft: ProfileDraft): Promise<void>;
  /** Sets the goal in effect from `from` on. Days before keep the goal they had. */
  saveGoal(draft: GoalDraft, from: LocalDate): Promise<void>;
  /** One document per drink, so drinks added on two phones offline both count. */
  addWater(ml: number, date: LocalDate): Promise<Undo>;
  deleteWater(id: WaterId): Promise<Undo>;
  /** Starts a fast now, unless one is already open. Started offline, it keeps the moment of the tap. */
  startFast(targetHours: number): Promise<Undo>;
  /** Ends every open fast, which also settles two phones' overlapping fasts. */
  endFast(): Promise<Undo>;
  /** Changes the target of the open fast, or of every one in an overlap. */
  setFastTarget(hours: number): Promise<void>;
}

export interface Clock {
  readonly now: () => Millis;
  readonly newId: () => string;
}

/** `next`, plus the fields of `before` that `known` does not name: what a newer app added. */
function keepUnknown<T extends object>(known: object, before: object | undefined, next: T): T {
  if (before === undefined) return next;
  return { ...Object.fromEntries(Object.entries(before).filter(([key]) => !Object.hasOwn(known, key))), ...next };
}

const nothingToUndo: Undo = () => Promise.resolve();

export function createIntents(replica: Pick<Replica, 'read' | 'commit'>, clock: Clock): Intents {
  const entriesFor = (placed: readonly (readonly [Ingredient, Slot])[]): Entry[] => {
    const start = clock.now();
    // Each item gets its own millisecond so the day lists them in the order they were logged.
    return placed.map(([item, slot], i) => makeEntry(item, slot, EntryId.parse(clock.newId()), Millis.parse(start + i)));
  };
  const unlog = (ids: readonly EntryId[]): Undo => () => replica.commit(ids.map((id) => ({ op: 'delete', kind: 'entry', id })));
  const log = async (entries: readonly Entry[]): Promise<Logged> => {
    await replica.commit(entries.map((doc) => ({ op: 'put', kind: 'entry', doc })));
    const ids = entries.map((e) => e.id);
    return { ids, undo: unlog(ids) };
  };

  const putFood = async (id: FoodId, draft: FoodDraft): Promise<Food> => {
    const before = await replica.read.get('food', id);
    const food = keepUnknown(Food.shape, before, { ...draft, id, archived: false });
    await replica.commit([{ op: 'put', kind: 'food', doc: food }]);
    return food;
  };

  const putRecipe = async (id: RecipeId, draft: RecipeDraft): Promise<Recipe> => {
    const before = await replica.read.get('recipe', id);
    const recipe = keepUnknown(Recipe.shape, before, { ...draft, id, archived: false });
    await replica.commit([{ op: 'put', kind: 'recipe', doc: recipe }]);
    return recipe;
  };

  return {
    logItems: (items, slot) => log(entriesFor(items.map((item) => [item, slot]))),

    copyDay: async (from, to) => {
      const source = (await replica.read.onDate('entry', from)).toSorted((a, b) => a.loggedAt - b.loggedAt);
      return log(entriesFor(source.map((entry) => [itemOf(entry), { date: to, meal: entry.meal }])));
    },

    editEntry: async (id, change) => {
      const before = await replica.read.get('entry', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'put', kind: 'entry', doc: { ...before, quantity: change.quantity, meal: change.meal } }]);
      return () => replica.commit([{ op: 'put', kind: 'entry', doc: before }]);
    },

    deleteEntry: async (id) => {
      const before = await replica.read.get('entry', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'delete', kind: 'entry', id }]);
      return () => replica.commit([{ op: 'put', kind: 'entry', doc: before }]);
    },

    importAndLog: async (candidate, quantity, slot) => {
      const completion = completeFood(candidate, FoodId.parse(clock.newId()));
      if (!completion.ok) return completion;
      const [entry] = entriesFor([[{ food: snapshotOf(completion.food), quantity }, slot]]);
      if (entry === undefined) throw new Error('no entry built');
      await replica.commit([
        { op: 'put', kind: 'food', doc: completion.food },
        { op: 'put', kind: 'entry', doc: entry },
      ]);
      return { ok: true, logged: { ids: [entry.id], undo: unlog([entry.id]) } };
    },

    createFood: (draft) => putFood(FoodId.parse(clock.newId()), draft),
    updateFood: (id, draft) => putFood(id, draft),

    importFood: async (candidate) => {
      const completion = completeFood(candidate, FoodId.parse(clock.newId()));
      if (completion.ok) await replica.commit([{ op: 'put', kind: 'food', doc: completion.food }]);
      return completion;
    },

    archiveFood: async (id) => {
      const before = await replica.read.get('food', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'put', kind: 'food', doc: { ...before, archived: true } }]);
      return () => replica.commit([{ op: 'put', kind: 'food', doc: before }]);
    },

    updateUsesOf: async (id) => {
      const [food, recipes, meals] = await Promise.all([replica.read.get('food', id), replica.read.all('recipe'), replica.read.all('savedMeal')]);
      if (food === undefined) return { recipes: 0, meals: 0, undo: nothingToUndo };
      const next = refreshFor(food, { recipes, meals });
      const changed = new Set<string>([...next.recipes, ...next.meals].map((d) => d.id));
      const before: Mutation[] = [
        ...recipes.filter((r) => changed.has(r.id)).map((doc): Mutation => ({ op: 'put', kind: 'recipe', doc })),
        ...meals.filter((m) => changed.has(m.id)).map((doc): Mutation => ({ op: 'put', kind: 'savedMeal', doc })),
      ];
      await replica.commit([
        ...next.recipes.map((doc): Mutation => ({ op: 'put', kind: 'recipe', doc })),
        ...next.meals.map((doc): Mutation => ({ op: 'put', kind: 'savedMeal', doc })),
      ]);
      return { recipes: next.recipes.length, meals: next.meals.length, undo: () => replica.commit(before) };
    },

    createRecipe: (draft) => putRecipe(RecipeId.parse(clock.newId()), draft),
    updateRecipe: (id, draft) => putRecipe(id, draft),

    archiveRecipe: async (id) => {
      const before = await replica.read.get('recipe', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'put', kind: 'recipe', doc: { ...before, archived: true } }]);
      return () => replica.commit([{ op: 'put', kind: 'recipe', doc: before }]);
    },

    saveMeal: async (draft) => {
      const meal: SavedMeal = { ...draft, id: SavedMealId.parse(clock.newId()), archived: false };
      await replica.commit([{ op: 'put', kind: 'savedMeal', doc: meal }]);
      return meal;
    },

    archiveMeal: async (id) => {
      const before = await replica.read.get('savedMeal', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'put', kind: 'savedMeal', doc: { ...before, archived: true } }]);
      return () => replica.commit([{ op: 'put', kind: 'savedMeal', doc: before }]);
    },

    saveProfile: async (draft) => {
      const before = await replica.read.get('profile', PROFILE_ID);
      await replica.commit([{ op: 'put', kind: 'profile', doc: keepUnknown(Profile.shape, before, { ...draft, id: PROFILE_ID }) }]);
    },

    saveGoal: async (draft, from) => {
      const id = goalId(from);
      const before = await replica.read.get('goal', id);
      await replica.commit([{ op: 'put', kind: 'goal', doc: keepUnknown(Goal.shape, before, { ...draft, id, effectiveFrom: from }) }]);
    },

    addWater: async (ml, date) => {
      const drink: Water = { id: WaterId.parse(clock.newId()), date, ml, loggedAt: clock.now() };
      await replica.commit([{ op: 'put', kind: 'water', doc: drink }]);
      return () => replica.commit([{ op: 'delete', kind: 'water', id: drink.id }]);
    },

    deleteWater: async (id) => {
      const before = await replica.read.get('water', id);
      if (before === undefined) return nothingToUndo;
      await replica.commit([{ op: 'delete', kind: 'water', id }]);
      return () => replica.commit([{ op: 'put', kind: 'water', doc: before }]);
    },

    startFast: async (targetHours) => {
      if (fastState(await replica.read.all('fast')).kind !== 'idle') return nothingToUndo;
      const fast: Fast = { id: FastId.parse(clock.newId()), startedAt: clock.now(), targetHours };
      await replica.commit([{ op: 'put', kind: 'fast', doc: fast }]);
      return () => replica.commit([{ op: 'delete', kind: 'fast', id: fast.id }]);
    },

    endFast: async () => {
      const fasts = await replica.read.all('fast');
      const ended = endOpen(fasts, clock.now());
      if (ended.length === 0) return nothingToUndo;
      const open = fasts.filter((f) => f.endedAt === undefined);
      await replica.commit(ended.map((doc) => ({ op: 'put', kind: 'fast', doc })));
      return () => replica.commit(open.map((doc) => ({ op: 'put', kind: 'fast', doc })));
    },

    setFastTarget: async (hours) => {
      const open = (await replica.read.all('fast')).filter((f) => f.endedAt === undefined);
      await replica.commit(open.map((f) => ({ op: 'put', kind: 'fast', doc: { ...f, targetHours: hours } })));
    },
  };
}
