/**
 * Every user action that changes data. Each intent builds whole documents with pure domain
 * functions and makes exactly one commit. Screens hand in Ingredients; they never build
 * documents.
 */
import { makeEntry, type Slot } from '../domain/diary.js';
import type { Ingredient } from '../domain/food.js';
import { EntryId, Millis } from '../domain/ids.js';
import type { Replica } from './replica.js';

/** Restores what an intent removed. Offered in the undo toast. */
export type Undo = () => Promise<void>;

export interface Intents {
  /**
   * The one way to put food in the diary: one entry per item, in one commit. Quick add,
   * and later recents, library foods and scans, all arrive as Ingredients.
   */
  logItems(items: readonly Ingredient[], slot: Slot): Promise<EntryId[]>;
  deleteEntry(id: EntryId): Promise<Undo>;
}

export interface Clock {
  readonly now: () => Millis;
  readonly newId: () => string;
}

export function createIntents(replica: Pick<Replica, 'read' | 'commit'>, clock: Clock): Intents {
  return {
    logItems: async (items, slot) => {
      const start = clock.now();
      // Each item gets its own millisecond so the day lists them in the order they were logged.
      const entries = items.map((item, i) => makeEntry(item, slot, EntryId.parse(clock.newId()), Millis.parse(start + i)));
      await replica.commit(entries.map((doc) => ({ op: 'put', kind: 'entry', doc })));
      return entries.map((e) => e.id);
    },
    deleteEntry: async (id) => {
      const before = await replica.read.get('entry', id);
      if (before === undefined) return () => Promise.resolve();
      await replica.commit([{ op: 'delete', kind: 'entry', id }]);
      return () => replica.commit([{ op: 'put', kind: 'entry', doc: before }]);
    },
  };
}
