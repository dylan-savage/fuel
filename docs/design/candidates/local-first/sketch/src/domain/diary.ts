import { z } from 'zod';
import { todo } from '../todo.js';
import { Ingredient, type FoodSnapshot, type Quantity } from './food.js';
import { EntryId, LocalDate, Millis } from './ids.js';
import type { Nutrients, Totals } from './nutrients.js';

export const Meal = z.enum(['breakfast', 'lunch', 'dinner', 'snacks']);
export type Meal = z.infer<typeof Meal>;

/**
 * One diary line. Holds a food snapshot by value, so editing or archiving the library food
 * later never changes a past day. Synced doc kind 'entry'.
 */
export const Entry = Ingredient.extend({
  id: EntryId,
  date: LocalDate,
  meal: Meal,
  loggedAt: Millis,
});
export type Entry = z.infer<typeof Entry>;

export interface Slot {
  readonly date: LocalDate;
  readonly meal: Meal;
}

export function makeEntry(item: Ingredient, slot: Slot, id: EntryId, now: Millis): Entry {
  return todo(`makeEntry(${item.food.name}, ${slot.date}, ${id}, ${now})`);
}

/** nutrientsFor(entry.food, entry.quantity). Never stored on the entry, so it cannot drift. */
export function entryNutrients(e: Entry): Nutrients {
  return todo(`entryNutrients(${e.id})`);
}

export function mealTotals(entries: readonly Entry[]): Totals {
  return todo(`mealTotals(${entries.length})`);
}

/**
 * Copies a day's entries to another date, each keeping its meal (intents.copyDay).
 * Snapshots are copied as eaten. ids come from the caller so the function stays pure.
 * Copying one meal needs no function: its entries are already Ingredients for logItems.
 */
export function cloneEntries(
  entries: readonly Entry[],
  to: { date: LocalDate; meal?: Meal },
  ids: readonly EntryId[],
  now: Millis,
): Entry[] {
  return todo(`cloneEntries(${entries.length}, ${to.date}, ${ids.length}, ${now})`);
}

/** Meal implied by local time of day, with Profile.dayStartsAtHour handling after-midnight snacks. */
export function mealAt(localHour: number): Meal {
  return todo(`mealAt(${localHour})`);
}

/** A food Dylan logs often, with the quantity and meal he used last time. */
export interface RecentFood {
  readonly food: FoodSnapshot;
  readonly lastQuantity: Quantity;
  readonly lastMeal: Meal;
  readonly uses: number;
  readonly lastUsed: Millis;
}

/**
 * Recent and frequent foods from the last 90 days of entries, grouped by snapshot origin
 * (adhoc snapshots group by name and brand), scored by uses with recency decay.
 * The newest snapshot in each group is the one offered, so a re-logged food shows its
 * latest nutrition. Pure and local, so the list is instant and works offline.
 */
export function recents(entries: readonly Entry[], now: Millis, limit: number): RecentFood[] {
  return todo(`recents(${entries.length}, ${now}, ${limit})`);
}
