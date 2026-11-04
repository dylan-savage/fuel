import { z } from 'zod';

/**
 * A diary day as Dylan chose it (YYYY-MM-DD). Written by the phone at log time and never
 * re-derived from a timestamp, so travel and late-night logging never move entries.
 */
export const LocalDate = z.iso.date().brand<'LocalDate'>();
export type LocalDate = z.infer<typeof LocalDate>;

/** Calendar arithmetic on diary days, done in UTC so no time zone or DST shift can skip a day. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return LocalDate.parse(at.toISOString().slice(0, 10));
}

/**
 * Epoch milliseconds from the writing device's clock. Display and within-day ordering only.
 * Sync never resolves anything by clock; the server's arrival order decides.
 */
export const Millis = z.number().int().nonnegative().brand<'Millis'>();
export type Millis = z.infer<typeof Millis>;

/** Random ids are minted only on the phone, so two creates never collide. */
export const FoodId = z.uuid().brand<'FoodId'>();
export type FoodId = z.infer<typeof FoodId>;

export const EntryId = z.uuid().brand<'EntryId'>();
export type EntryId = z.infer<typeof EntryId>;

export const RecipeId = z.uuid().brand<'RecipeId'>();
export type RecipeId = z.infer<typeof RecipeId>;

export const SavedMealId = z.uuid().brand<'SavedMealId'>();
export type SavedMealId = z.infer<typeof SavedMealId>;

export const WaterId = z.uuid().brand<'WaterId'>();
export type WaterId = z.infer<typeof WaterId>;

export const FastId = z.uuid().brand<'FastId'>();
export type FastId = z.infer<typeof FastId>;

export const FastEndId = z.uuid().brand<'FastEndId'>();
export type FastEndId = z.infer<typeof FastEndId>;

export const WorkoutId = z.uuid().brand<'WorkoutId'>();
export type WorkoutId = z.infer<typeof WorkoutId>;

/** Minted on the phone, or derived from date and day by the importer. The session's workout takes the same id. */
export const SessionId = z.uuid().brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const TrainingNoteId = z.uuid().brand<'TrainingNoteId'>();
export type TrainingNoteId = z.infer<typeof TrainingNoteId>;

/** p:<effectiveFrom>, so saving a version twice on one date converges to one document. */
export const ProgramId = z
  .string()
  .regex(/^p:\d{4}-\d{2}-\d{2}$/)
  .brand<'ProgramId'>();
export type ProgramId = z.infer<typeof ProgramId>;

/** pf:<session>:<slot>:<lift>, so each set rewrites one exercise's document. */
export const PerformanceId = z.string().startsWith('pf:').brand<'PerformanceId'>();
export type PerformanceId = z.infer<typeof PerformanceId>;

/** 1 is Monday and 7 is Sunday, as a plan's Day.weekday counts. */
export function weekdayOf(date: LocalDate): number {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The Monday of the calendar week holding `date`. A week is this value and nothing else. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - weekdayOf(date));
}

export function isMonday(date: LocalDate): boolean {
  return mondayOf(date) === date;
}
