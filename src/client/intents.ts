/**
 * Every user action that changes data. Each intent builds whole documents with pure domain
 * functions and makes exactly one commit. Screens hand in Ingredients and drafts; they never
 * build documents.
 */
import { makeEntry, type Meal, type Slot } from '../domain/diary.js';
import {
  Food,
  completeFood,
  snapshotOf,
  type FoodCandidate,
  type FoodDraft,
  type Ingredient,
  type Quantity,
} from '../domain/food.js';
import { Goal, PROFILE_ID, Profile, goalId, type GoalDraft, type ProfileDraft } from '../domain/goals.js';
import { EntryId, FoodId, Millis, type LocalDate } from '../domain/ids.js';
import type { CoreKey } from '../domain/nutrients.js';
import type { Replica } from './replica.js';

/** Restores what an intent changed. Offered in the undo toast. */
export type Undo = () => Promise<void>;

export interface Logged {
  readonly ids: readonly EntryId[];
  readonly undo: Undo;
}

export type Imported = { readonly ok: true; readonly logged: Logged } | { readonly ok: false; readonly missing: readonly CoreKey[] };

export interface Intents {
  /** The one way to put food in the diary: one entry per item, in one commit. */
  logItems(items: readonly Ingredient[], slot: Slot): Promise<Logged>;
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
  /** Foods are archived, never deleted, so entries keep meaningful provenance. */
  archiveFood(id: FoodId): Promise<Undo>;
  saveProfile(draft: ProfileDraft): Promise<void>;
  /** Sets the goal in effect from `from` on. Days before keep the goal they had. */
  saveGoal(draft: GoalDraft, from: LocalDate): Promise<void>;
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

export function createIntents(replica: Pick<Replica, 'read' | 'commit'>, clock: Clock): Intents {
  const entriesFor = (items: readonly Ingredient[], slot: Slot) => {
    const start = clock.now();
    // Each item gets its own millisecond so the day lists them in the order they were logged.
    return items.map((item, i) => makeEntry(item, slot, EntryId.parse(clock.newId()), Millis.parse(start + i)));
  };
  const unlog = (ids: readonly EntryId[]): Undo => () => replica.commit(ids.map((id) => ({ op: 'delete', kind: 'entry', id })));

  const putFood = async (id: FoodId, draft: FoodDraft): Promise<Food> => {
    const before = await replica.read.get('food', id);
    const food = keepUnknown(Food.shape, before, { ...draft, id, archived: false });
    await replica.commit([{ op: 'put', kind: 'food', doc: food }]);
    return food;
  };

  return {
    logItems: async (items, slot) => {
      const entries = entriesFor(items, slot);
      await replica.commit(entries.map((doc) => ({ op: 'put', kind: 'entry', doc })));
      const ids = entries.map((e) => e.id);
      return { ids, undo: unlog(ids) };
    },

    editEntry: async (id, change) => {
      const before = await replica.read.get('entry', id);
      if (before === undefined) return () => Promise.resolve();
      await replica.commit([{ op: 'put', kind: 'entry', doc: { ...before, quantity: change.quantity, meal: change.meal } }]);
      return () => replica.commit([{ op: 'put', kind: 'entry', doc: before }]);
    },

    deleteEntry: async (id) => {
      const before = await replica.read.get('entry', id);
      if (before === undefined) return () => Promise.resolve();
      await replica.commit([{ op: 'delete', kind: 'entry', id }]);
      return () => replica.commit([{ op: 'put', kind: 'entry', doc: before }]);
    },

    importAndLog: async (candidate, quantity, slot) => {
      const completion = completeFood(candidate, FoodId.parse(clock.newId()));
      if (!completion.ok) return completion;
      const [entry] = entriesFor([{ food: snapshotOf(completion.food), quantity }], slot);
      if (entry === undefined) throw new Error('no entry built');
      await replica.commit([
        { op: 'put', kind: 'food', doc: completion.food },
        { op: 'put', kind: 'entry', doc: entry },
      ]);
      return { ok: true, logged: { ids: [entry.id], undo: unlog([entry.id]) } };
    },

    createFood: (draft) => putFood(FoodId.parse(clock.newId()), draft),
    updateFood: (id, draft) => putFood(id, draft),

    archiveFood: async (id) => {
      const before = await replica.read.get('food', id);
      if (before === undefined) return () => Promise.resolve();
      await replica.commit([{ op: 'put', kind: 'food', doc: { ...before, archived: true } }]);
      return () => replica.commit([{ op: 'put', kind: 'food', doc: before }]);
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
  };
}
