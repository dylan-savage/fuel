/**
 * Read models for screens. Each view reads replica docs and hands them to one pure domain
 * function. Screens call them through useLive, so they re-render on local writes and on
 * sync merges alike.
 */
import { todo } from '../todo.js';
import type { TdeeEstimate, TrendPoint } from '../domain/body.js';
import type { RecentFood } from '../domain/diary.js';
import type { FoodSnapshot, Ingredient } from '../domain/food.js';
import type { DaySummary } from '../domain/goals.js';
import type { FastStatus } from '../domain/habits.js';
import type { FoodId, LocalDate, Millis, RecipeId, SavedMealId } from '../domain/ids.js';
import type { ReplicaReader } from './replica.js';

/** entries, goals, profile, trend weight, exercise, health and water for date, then summarizeDay. */
export function dayView(r: ReplicaReader, date: LocalDate): Promise<DaySummary> {
  return todo(`dayView(${typeof r}, ${date})`);
}

/** recents() over the last 90 days of entries. */
export function recentFoods(r: ReplicaReader, now: Millis, limit: number): Promise<RecentFood[]> {
  return todo(`recentFoods(${typeof r}, ${now}, ${limit})`);
}

export type LibraryHit =
  | { readonly kind: 'food'; readonly id: FoodId; readonly snapshot: FoodSnapshot }
  | { readonly kind: 'recipe'; readonly id: RecipeId; readonly snapshot: FoodSnapshot }
  | { readonly kind: 'savedMeal'; readonly id: SavedMealId; readonly name: string; readonly items: readonly Ingredient[] };

/**
 * Every hit carries what logItems needs (a snapshot, or a saved meal's items), so logging a
 * search result is one call with no second read.
 * Case- and accent-insensitive token prefix match over non-archived foods, recipes and saved
 * meals, filtered in memory. The library is hundreds to low thousands of docs, so a scan is
 * a few milliseconds and needs no index.
 */
export function searchLibrary(r: ReplicaReader, q: string): Promise<LibraryHit[]> {
  return todo(`searchLibrary(${typeof r}, ${q})`);
}

export interface WeightView {
  readonly points: readonly TrendPoint[];
  readonly kgPerWeek: number | null;
  readonly projectedGoalDate: LocalDate | null;
  readonly adaptiveTdee: TdeeEstimate | null;
}

export function weightView(r: ReplicaReader, days: number, today: LocalDate): Promise<WeightView> {
  return todo(`weightView(${typeof r}, ${days}, ${today})`);
}

export function fastView(r: ReplicaReader, now: Millis): Promise<FastStatus> {
  return todo(`fastView(${typeof r}, ${now})`);
}

/**
 * Preact hook over Replica.live with the replica from context. undefined only on the very
 * first frame before IndexedDB answers.
 */
export function useLive<T>(query: (r: ReplicaReader) => Promise<T>, deps: readonly unknown[]): T | undefined {
  return todo(`useLive(${typeof query}, ${deps.length})`);
}
