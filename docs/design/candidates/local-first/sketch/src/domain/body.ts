import { z } from 'zod';
import { todo } from '../todo.js';
import type { HealthDay } from './burn.js';
import { LocalDate, Millis, WeighInId } from './ids.js';
import { Kg } from './units.js';

/** A manual weigh-in. id = weighInId(date), so there is at most one per day. Synced doc kind 'weighIn'. */
export const WeighIn = z.object({ id: WeighInId, date: LocalDate, kg: Kg, at: Millis });
export type WeighIn = z.infer<typeof WeighIn>;

export interface DailyWeight {
  readonly date: LocalDate;
  readonly kg: Kg;
  readonly source: 'manual' | 'health';
}

/**
 * Merges the two weight writers at read time: a manual weigh-in beats a Health weight on
 * the same day. Neither writer ever touches the other's documents.
 */
export function dailyWeights(weighIns: readonly WeighIn[], health: readonly HealthDay[]): DailyWeight[] {
  return todo(`dailyWeights(${weighIns.length}, ${health.length})`);
}

export interface TrendPoint {
  readonly date: LocalDate;
  readonly trendKg: Kg;
  readonly scaleKg: Kg | null;
}

/**
 * Hacker's Diet trend: per calendar day, trend += alpha * (weight - trend). Gaps between
 * weigh-ins are linearly interpolated first, so alpha keeps its per-day meaning.
 * Seeded with the first weight.
 */
export function trend(daily: readonly DailyWeight[], alpha: number): TrendPoint[] {
  return todo(`trend(${daily.length}, ${alpha})`);
}

/** kg per week from the trend over the trailing window (default 14 days). Negative = losing. */
export function weeklyRate(points: readonly TrendPoint[], windowDays: number): number | null {
  return todo(`weeklyRate(${points.length}, ${windowDays})`);
}

export function projectedGoalDate(points: readonly TrendPoint[], targetKg: Kg, kgPerWeek: number): LocalDate | null {
  return todo(`projectedGoalDate(${points.length}, ${targetKg}, ${kgPerWeek})`);
}

export interface TdeeEstimate {
  readonly kcal: number;
  readonly loggedDays: number;
  readonly windowDays: number;
}

/**
 * MacroFactor-style estimate: mean intake over logged days minus trend change x KCAL_PER_KG
 * over the window. Days with no entries, or under 800 kcal, count as unlogged and are
 * excluded. Null with fewer than 14 logged days.
 */
export function adaptiveTdee(
  intakeByDay: ReadonlyMap<LocalDate, number>,
  points: readonly TrendPoint[],
  windowDays: number,
): TdeeEstimate | null {
  return todo(`adaptiveTdee(${intakeByDay.size}, ${points.length}, ${windowDays})`);
}
