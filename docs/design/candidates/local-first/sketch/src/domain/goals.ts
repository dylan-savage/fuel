import { z } from 'zod';
import { todo } from '../todo.js';
import type { DayBurn, Exercise, HealthDay } from './burn.js';
import type { Entry, Meal } from './diary.js';
import type { WaterLog } from './habits.js';
import { GoalId, LocalDate } from './ids.js';
import type { Totals } from './nutrients.js';
import { Kcal, Kg } from './units.js';

export const ActivityLevel = z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']);
export type ActivityLevel = z.infer<typeof ActivityLevel>;

export const ACTIVITY_MULTIPLIER: Readonly<Record<ActivityLevel, number>> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Singleton settings doc (id 'me'). Synced doc kind 'profile'. */
export const Profile = z.object({
  id: z.literal('me'),
  sex: z.enum(['male', 'female']),
  birthDate: LocalDate,
  heightCm: z.number().positive().max(250),
  activity: ActivityLevel,
  display: z.object({ weight: z.enum(['lb', 'kg']), water: z.enum(['floz', 'ml']) }),
  waterGoalMl: z.number().positive(),
  fastTargetHours: z.number().positive().max(72),
  /** Entries logged before this local hour count toward the previous diary day. */
  dayStartsAtHour: z.number().int().min(0).max(6),
});
export type Profile = z.infer<typeof Profile>;

export const CalorieTarget = z.discriminatedUnion('kind', [
  /** kgPerWeek < 0 loses weight. Target = TDEE + kgPerWeek x KCAL_PER_KG / 7. */
  z.object({ kind: z.literal('rate'), kgPerWeek: z.number().min(-1.5).max(1) }),
  z.object({ kind: z.literal('fixed'), kcal: z.number().positive() }),
]);

export const MacroTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grams'), protein: z.number(), carbs: z.number(), fat: z.number() }),
  z
    .object({ kind: z.literal('percent'), protein: z.number(), carbs: z.number(), fat: z.number() })
    .refine((m) => Math.abs(m.protein + m.carbs + m.fat - 100) < 0.5, 'percent split sums to 100'),
]);

/**
 * How burn changes the day's budget.
 * 'ignore': the activity multiplier already covers activity; burn is shown, not credited.
 * 'eat-back': the baseline uses the sedentary multiplier, and fraction x dayBurn is added.
 * Either way burn is counted once, which is the double-count guarantee.
 */
export const BurnPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignore') }),
  z.object({ kind: z.literal('eat-back'), fraction: z.number().min(0).max(1) }),
]);

/**
 * A goal in effect from a date until the next goal. Past days keep the goal that applied
 * to them because goals are effective-dated, never overwritten. Synced doc kind 'goal'.
 */
export const Goal = z.object({
  id: GoalId,
  effectiveFrom: LocalDate,
  calories: CalorieTarget,
  macros: MacroTarget,
  burn: BurnPolicy,
});
export type Goal = z.infer<typeof Goal>;

/** Mifflin-St Jeor. */
export function bmr(p: { sex: Profile['sex']; kg: Kg; heightCm: number; ageYears: number }): Kcal {
  return todo(`bmr(${p.sex}, ${p.kg})`);
}

export function tdee(bmrKcal: Kcal, activity: ActivityLevel): Kcal {
  return todo(`tdee(${bmrKcal}, ${activity})`);
}

/** The goal with the latest effectiveFrom on or before date. */
export function goalOn(goals: readonly Goal[], date: LocalDate): Goal | null {
  return todo(`goalOn(${goals.length}, ${date})`);
}

export interface Budget {
  readonly baseKcal: Kcal;
  readonly burnCreditKcal: Kcal;
  readonly targetKcal: Kcal;
  readonly macrosG: { readonly protein: number; readonly carbs: number; readonly fat: number };
}

/** Pure budget math for one day. Needs the trend weight on that day for BMR. */
export function budgetFor(goal: Goal, profile: Profile, date: LocalDate, trendKg: Kg, burn: DayBurn): Budget {
  return todo(`budgetFor(${goal.id}, ${profile.id}, ${date}, ${trendKg}, ${burn.kcal})`);
}

export interface DaySummary {
  readonly date: LocalDate;
  readonly byMeal: Readonly<Record<Meal, { readonly entries: readonly Entry[]; readonly totals: Totals }>>;
  readonly eaten: Totals;
  readonly burn: DayBurn;
  /** Null until a profile, a goal and one weigh-in exist. The UI then shows totals only. */
  readonly budget: Budget | null;
  readonly remainingKcal: number | null;
  readonly waterMl: number;
  readonly waterGoalMl: number | null;
}

/** Everything the diary screen shows for a day, derived from replica docs in one pure call. */
export function summarizeDay(input: {
  date: LocalDate;
  entries: readonly Entry[];
  goals: readonly Goal[];
  profile: Profile | null;
  trendKg: Kg | null;
  exercise: readonly Exercise[];
  health: HealthDay | null;
  water: readonly WaterLog[];
}): DaySummary {
  return todo(`summarizeDay(${input.date})`);
}
