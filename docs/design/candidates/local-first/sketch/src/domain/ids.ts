import { z } from 'zod';
import { todo } from '../todo.js';

/**
 * A diary day as Dylan chose it (YYYY-MM-DD). Written by the phone at log time and
 * never re-derived from a timestamp, so travel and late-night logging never move entries.
 */
export const LocalDate = z.iso.date().brand<'LocalDate'>();
export type LocalDate = z.infer<typeof LocalDate>;

/**
 * Epoch milliseconds from the writing device's clock. Display and within-day ordering only.
 * Sync conflicts are never resolved by clocks; the server's rev order decides.
 */
export const Millis = z.number().int().nonnegative().brand<'Millis'>();
export type Millis = z.infer<typeof Millis>;

// Random ids. Minted only on the client (client/intents.ts), never on the server.
export const FoodId = z.uuid().brand<'FoodId'>();
export type FoodId = z.infer<typeof FoodId>;
export const RecipeId = z.uuid().brand<'RecipeId'>();
export type RecipeId = z.infer<typeof RecipeId>;
export const SavedMealId = z.uuid().brand<'SavedMealId'>();
export type SavedMealId = z.infer<typeof SavedMealId>;
export const EntryId = z.uuid().brand<'EntryId'>();
export type EntryId = z.infer<typeof EntryId>;
export const ExerciseId = z.uuid().brand<'ExerciseId'>();
export type ExerciseId = z.infer<typeof ExerciseId>;
export const WaterId = z.uuid().brand<'WaterId'>();
export type WaterId = z.infer<typeof WaterId>;
export const FastId = z.uuid().brand<'FastId'>();
export type FastId = z.infer<typeof FastId>;

// Deterministic ids. One logical thing per day maps to one document, so "log it twice"
// converges to a single doc instead of a duplicate.
export const WeighInId = z.string().regex(/^w:\d{4}-\d{2}-\d{2}$/).brand<'WeighInId'>();
export type WeighInId = z.infer<typeof WeighInId>;
export const GoalId = z.string().regex(/^g:\d{4}-\d{2}-\d{2}$/).brand<'GoalId'>();
export type GoalId = z.infer<typeof GoalId>;
export const HealthDayId = z.string().regex(/^h:\d{4}-\d{2}-\d{2}$/).brand<'HealthDayId'>();
export type HealthDayId = z.infer<typeof HealthDayId>;

/** At most one weigh-in per diary day. A second weigh-in that day replaces the first. */
export function weighInId(date: LocalDate): WeighInId {
  return todo(`weighInId(${date})`);
}
/** A goal takes effect from a date. Editing today's goal twice updates one doc. */
export function goalId(effectiveFrom: LocalDate): GoalId {
  return todo(`goalId(${effectiveFrom})`);
}
/** One Health document per day, written only by the ingest route. */
export function healthDayId(date: LocalDate): HealthDayId {
  return todo(`healthDayId(${date})`);
}

/**
 * GTIN normalized to 13 digits (UPC-A gains a leading 0) or kept at 8 for EAN-8, with the
 * check digit verified. One product has one key whichever symbology the decoder reported.
 */
export const Gtin = z.string().regex(/^(\d{8}|\d{13})$/).brand<'Gtin'>();
export type Gtin = z.infer<typeof Gtin>;

/** Returns null for anything that is not a valid EAN-8, UPC-A or EAN-13 after normalization. */
export function parseGtin(raw: string): Gtin | null {
  return todo(`parseGtin(${raw})`);
}
