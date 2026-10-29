import { z } from 'zod';
import { Ingredient, nutrientsFor } from './food.js';
import { EntryId, LocalDate, Millis } from './ids.js';
import { total, type Nutrients, type Totals } from './nutrients.js';

export const Meal = z.enum(['breakfast', 'lunch', 'dinner', 'snacks']);
export type Meal = z.infer<typeof Meal>;

/** One diary line. Synced document kind 'entry'. */
export const Entry = Ingredient.extend({
  id: EntryId,
  date: LocalDate,
  meal: Meal,
  loggedAt: Millis,
});
export type Entry = z.infer<typeof Entry>;

/** Where an item lands in the diary. */
export interface Slot {
  readonly date: LocalDate;
  readonly meal: Meal;
}

export function makeEntry(item: Ingredient, slot: Slot, id: EntryId, loggedAt: Millis): Entry {
  return { ...item, id, date: slot.date, meal: slot.meal, loggedAt };
}

/** Computed on read, never stored on the entry, so it cannot drift from the snapshot. */
export function entryNutrients(entry: Entry): Nutrients {
  return nutrientsFor(entry.food, entry.quantity);
}

export interface DaySummary {
  /** Oldest first. */
  readonly entries: readonly Entry[];
  readonly totals: Totals;
}

export function summarizeDay(entries: readonly Entry[]): DaySummary {
  const sorted = entries.toSorted((a, b) => a.loggedAt - b.loggedAt);
  return { entries: sorted, totals: total(sorted.map(entryNutrients)) };
}

/** The meal a log most likely belongs to at this local hour (0 to 23). */
export function mealAt(localHour: number): Meal {
  if (localHour >= 4 && localHour < 11) return 'breakfast';
  if (localHour >= 11 && localHour < 15) return 'lunch';
  if (localHour >= 17 && localHour < 22) return 'dinner';
  return 'snacks';
}
