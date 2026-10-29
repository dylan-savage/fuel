import { z } from 'zod';
import type { Profile } from './goals.js';
import { LocalDate, Millis, addDays } from './ids.js';

/** A body weight in kg. Stored in kg everywhere and shown in lb. */
export const BodyKg = z.number().positive().max(635);

/** One weigh-in per day, so weighing in twice on a day converges to one document. */
export function weighInId(date: LocalDate): string {
  return `w:${date}`;
}

/**
 * A scale reading for a day. Logging again on the same day rewrites this document, so the
 * latest edit wins. Synced document kind 'weighIn'.
 */
export const WeighIn = z
  .looseObject({
    id: z.string(),
    date: LocalDate,
    kg: BodyKg,
    loggedAt: Millis,
  })
  .refine((w) => w.id === weighInId(w.date), 'a weigh-in id is w:<date>');
export type WeighIn = z.infer<typeof WeighIn>;

/** The Hacker's Diet smoothing factor: each weigh-in moves the trend a tenth of the way to it. */
export const TREND_ALPHA = 0.1;

export interface TrendPoint {
  readonly date: LocalDate;
  readonly trendKg: number;
  /** The weigh-in that day, if Dylan stepped on the scale. */
  readonly scaleKg: number | null;
}

/**
 * The smoothed trend for every calendar day from the first weigh-in through `through`,
 * oldest first. The first weigh-in seeds it. Each later weigh-in moves it by
 * TREND_ALPHA × (weight − trend), and a day with no weigh-in carries it unchanged.
 * Empty before the first weigh-in.
 */
export function trendSeries(weighIns: readonly WeighIn[], through: LocalDate): TrendPoint[] {
  const known = weighIns.filter((w) => w.date <= through).toSorted((a, b) => a.date.localeCompare(b.date));
  const [first] = known;
  if (first === undefined) return [];
  const scale = new Map(known.map((w) => [w.date, w.kg]));
  const points: TrendPoint[] = [];
  let trendKg = first.kg;
  for (let date = first.date; date <= through; date = addDays(date, 1)) {
    const kg = scale.get(date);
    if (kg !== undefined) trendKg += TREND_ALPHA * (kg - trendKg);
    points.push({ date, trendKg, scaleKg: kg ?? null });
  }
  return points;
}

/** What Dylan weighs on a day for the budget and workout burn, and where the number came from. */
export interface BodyWeight {
  readonly kg: number;
  readonly source: 'trend' | 'profile';
}

/**
 * The trend on `date`. Before the first weigh-in, the profile's weight, which is what those
 * days were budgeted with, so starting to weigh in leaves them alone. A single weigh-in is
 * its own trend, so the latest weigh-in needs no separate fallback.
 */
export function bodyWeightOn(weighIns: readonly WeighIn[], profile: Profile | undefined, date: LocalDate): BodyWeight | undefined {
  const trendKg = trendSeries(weighIns, date).at(-1)?.trendKg;
  if (trendKg !== undefined) return { kg: trendKg, source: 'trend' };
  return profile === undefined ? undefined : { kg: profile.weightKg, source: 'profile' };
}

/** The rate looks at the trend over this many days, ending at the day it is read. */
export const RATE_DAYS = 14;
/** Weigh-ins the rate window needs before the rate means anything. */
export const RATE_MIN_WEIGH_INS = 7;

export type WeeklyRate = { readonly kind: 'rate'; readonly kgPerWeek: number } | { readonly kind: 'not-enough-data' };

/**
 * Kg per week, negative when losing: the least-squares slope of the trend over the last
 * RATE_DAYS days of `series`. It needs a trend that spans the whole window and
 * RATE_MIN_WEIGH_INS weigh-ins inside it, so one or two readings never make a rate.
 */
export function weeklyRate(series: readonly TrendPoint[]): WeeklyRate {
  const window = series.slice(-RATE_DAYS);
  if (window.length < RATE_DAYS || window.filter((p) => p.scaleKg !== null).length < RATE_MIN_WEIGH_INS) return { kind: 'not-enough-data' };
  const meanX = (window.length - 1) / 2;
  const meanY = window.reduce((sum, p) => sum + p.trendKg, 0) / window.length;
  let covariance = 0;
  let variance = 0;
  window.forEach((p, x) => {
    covariance += (x - meanX) * (p.trendKg - meanY);
    variance += (x - meanX) ** 2;
  });
  return { kind: 'rate', kgPerWeek: (covariance / variance) * 7 };
}

/** Within this of the goal weight counts as there. About half a pound. */
export const REACHED_KG = 0.25;
/** Slower than this, about 0.1 lb a week, projects no date. */
export const STEADY_KG_PER_WEEK = 0.05;

export type Projection =
  | { readonly kind: 'no-goal' }
  | { readonly kind: 'not-enough-data' }
  | { readonly kind: 'reached' }
  | { readonly kind: 'steady' }
  | { readonly kind: 'away' }
  | { readonly kind: 'on-course'; readonly date: LocalDate };

/** When the trend reaches the goal weight at the current rate, counted from `from`. */
export function projectGoal(input: {
  readonly trendKg: number | undefined;
  readonly rate: WeeklyRate;
  readonly goalKg: number | undefined;
  readonly from: LocalDate;
}): Projection {
  const { trendKg, rate, goalKg } = input;
  if (goalKg === undefined) return { kind: 'no-goal' };
  if (trendKg === undefined) return { kind: 'not-enough-data' };
  const toGo = goalKg - trendKg;
  if (Math.abs(toGo) <= REACHED_KG) return { kind: 'reached' };
  if (rate.kind === 'not-enough-data') return { kind: 'not-enough-data' };
  if (Math.abs(rate.kgPerWeek) < STEADY_KG_PER_WEEK) return { kind: 'steady' };
  if (Math.sign(rate.kgPerWeek) !== Math.sign(toGo)) return { kind: 'away' };
  return { kind: 'on-course', date: addDays(input.from, Math.ceil((toGo / rate.kgPerWeek) * 7)) };
}
