import { z } from 'zod';
import { BodyKg, bodyWeightOn, type BodyWeight, type WeighIn } from './body.js';
import { workoutKcal, type Workout } from './burn.js';
import { LocalDate } from './ids.js';
import { KCAL_PER_GRAM, MACROS, type Macro, type Totals } from './nutrients.js';

export const Sex = z.enum(['male', 'female']);
export type Sex = z.infer<typeof Sex>;

export const ActivityLevel = z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']);
export type ActivityLevel = z.infer<typeof ActivityLevel>;

/** TDEE = BMR × multiplier. The standard Mifflin-St Jeor companion table. */
export const ACTIVITY: Readonly<Record<ActivityLevel, { readonly label: string; readonly detail: string; readonly multiplier: number }>> = {
  sedentary: { label: 'Sedentary', detail: 'Desk job, little exercise', multiplier: 1.2 },
  light: { label: 'Lightly active', detail: 'Exercise 1 to 3 days a week', multiplier: 1.375 },
  moderate: { label: 'Moderately active', detail: 'Exercise 3 to 5 days a week', multiplier: 1.55 },
  active: { label: 'Very active', detail: 'Hard exercise 6 to 7 days a week', multiplier: 1.725 },
  very_active: { label: 'Extremely active', detail: 'Physical job plus hard training', multiplier: 1.9 },
};

export const KG_PER_LB = 0.45359237;
/** The rule the rate picker speaks: 1 lb a week is 500 kcal a day. */
export const KCAL_PER_LB = 3500;
export const CM_PER_INCH = 2.54;

export const PROFILE_ID = 'me';

/** The singleton body profile. Synced document kind 'profile'. */
export const Profile = z.looseObject({
  id: z.literal(PROFILE_ID),
  sex: Sex,
  birthDate: LocalDate,
  heightCm: z.number().positive().max(272),
  /** The starting weight, in kg. BMR uses it only on days before the first weigh-in. */
  weightKg: BodyKg,
});
export type Profile = z.infer<typeof Profile>;

export const ProfileDraft = Profile.omit({ id: true });
export type ProfileDraft = z.infer<typeof ProfileDraft>;

/**
 * How workouts meet the daily target. `activity-level` folds exercise into the activity
 * multiplier, so logged workouts never change the target. `eat-back-workouts` starts from
 * the sedentary baseline and adds `fraction` of each day's workout kcal.
 */
export const BudgetPolicy = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('activity-level'), level: ActivityLevel }),
  z.looseObject({ kind: z.literal('eat-back-workouts'), fraction: z.number().min(0).max(1) }),
]);
export type BudgetPolicy = z.infer<typeof BudgetPolicy>;

/** Desk job, no exercise: the baseline that eaten-back workouts sit on. */
export const BASELINE_MULTIPLIER = ACTIVITY.sedentary.multiplier;

/** What a policy multiplies BMR by, and the share of the day's workout kcal it adds. */
export function policyTerms(policy: BudgetPolicy): { readonly multiplier: number; readonly workoutShare: number } {
  switch (policy.kind) {
    case 'activity-level':
      return { multiplier: ACTIVITY[policy.level].multiplier, workoutShare: 0 };
    case 'eat-back-workouts':
      return { multiplier: BASELINE_MULTIPLIER, workoutShare: policy.fraction };
  }
}

/** The most water a daily goal may ask for. */
export const MAX_WATER_ML = 10_000;

const percent = z.number().min(0).max(100);
const grams = z.number().nonnegative().max(2000);

export const MacroTarget = z.discriminatedUnion('kind', [
  z
    .looseObject({ kind: z.literal('percent'), protein: percent, carbs: percent, fat: percent })
    .refine((m) => Math.abs(m.protein + m.carbs + m.fat - 100) < 0.5, 'a percent split sums to 100'),
  z.looseObject({ kind: z.literal('grams'), protein: grams, carbs: grams, fat: grams }),
]);
export type MacroTarget = z.infer<typeof MacroTarget>;

/** One goal per effective date, so saving twice on a day converges to one document. */
export function goalId(effectiveFrom: LocalDate): string {
  return `g:${effectiveFrom}`;
}

const GoalFields = z.looseObject({
  id: z.string(),
  effectiveFrom: LocalDate,
  policy: BudgetPolicy,
  /** Weekly body weight change. Negative loses. */
  kgPerWeek: z.number().min(-1.2).max(1.2),
  /** Replaces the computed daily target when set. */
  kcalOverride: z.number().positive().max(20_000).optional(),
  macros: MacroTarget,
  /** The daily water goal, stored in ml. Goals saved before water existed have none. */
  waterMl: z.number().positive().max(MAX_WATER_ML).optional(),
  /** Where the weight trend is headed, in kg. The projection counts toward it. */
  goalWeightKg: BodyKg.optional(),
});

/**
 * A goal in effect from `effectiveFrom` until the next goal. Saving a new goal never
 * rewrites an old one, so past days keep their own target. Synced document kind 'goal'.
 */
export const Goal = GoalFields.refine((g) => g.id === goalId(g.effectiveFrom), 'a goal id is g:<effectiveFrom>');
export type Goal = z.infer<typeof Goal>;

/** What the goal screen edits; the effective date and id come from the day it is saved. */
export const GoalDraft = GoalFields.omit({ id: true, effectiveFrom: true });
export type GoalDraft = z.infer<typeof GoalDraft>;

/** Whole years on `date`. */
export function ageOn(birthDate: LocalDate, date: LocalDate): number {
  const [by = 0, bm = 0, bd = 0] = birthDate.split('-').map(Number);
  const [y = 0, m = 0, d = 0] = date.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Mifflin-St Jeor resting energy, kcal a day. */
export function bmr(p: { readonly sex: Sex; readonly kg: number; readonly cm: number; readonly age: number }): number {
  return 10 * p.kg + 6.25 * p.cm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
}

/** Daily kcal change that a weekly weight change needs. Losing 1 lb a week is −500. */
export function rateKcal(kgPerWeek: number): number {
  return ((kgPerWeek / KG_PER_LB) * KCAL_PER_LB) / 7;
}

/** The goal with the latest effectiveFrom on or before `date`. */
export function goalOn(goals: readonly Goal[], date: LocalDate): Goal | undefined {
  let best: Goal | undefined;
  for (const goal of goals) {
    if (goal.effectiveFrom <= date && (best === undefined || goal.effectiveFrom > best.effectiveFrom)) best = goal;
  }
  return best;
}

export function macroGrams(macros: MacroTarget, kcal: number): Readonly<Record<Macro, number>> {
  switch (macros.kind) {
    case 'grams':
      return { protein: macros.protein, carbs: macros.carbs, fat: macros.fat };
    case 'percent': {
      const split = (macro: Macro) => Math.round((kcal * macros[macro]) / 100 / KCAL_PER_GRAM[macro]);
      return { protein: split('protein'), carbs: split('carbs'), fat: split('fat') };
    }
  }
}

export type BudgetBasis =
  | {
      readonly kind: 'computed';
      readonly bmr: number;
      readonly weight: BodyWeight;
      readonly multiplier: number;
      /** BMR × multiplier. */
      readonly tdee: number;
      readonly rate: number;
    }
  | { readonly kind: 'manual' };

/** One day's targets. Derived on read, never stored. */
export interface Budget {
  readonly basis: BudgetBasis;
  /** The target before workouts. */
  readonly baseKcal: number;
  /** What the day's workouts add. Always 0 under `activity-level`. */
  readonly workoutKcal: number;
  /** baseKcal + workoutKcal. */
  readonly kcal: number;
  /** Grams. */
  readonly macros: Readonly<Record<Macro, number>>;
}

/** What a day's target depends on besides the goal. */
export interface DayFacts {
  readonly profile: Profile | undefined;
  /** Every weigh-in: BMR reads the trend on the day. */
  readonly weighIns: readonly WeighIn[];
  /** That day's workouts. */
  readonly workouts: readonly Workout[];
}

function baseFor(goal: Goal, facts: DayFacts, date: LocalDate, multiplier: number): { readonly basis: BudgetBasis; readonly kcal: number } | null {
  if (goal.kcalOverride !== undefined) return { basis: { kind: 'manual' }, kcal: goal.kcalOverride };
  const { profile } = facts;
  const weight = bodyWeightOn(facts.weighIns, profile, date);
  if (profile === undefined || weight === undefined) return null;
  const rest = bmr({ sex: profile.sex, kg: weight.kg, cm: profile.heightCm, age: ageOn(profile.birthDate, date) });
  const total = rest * multiplier;
  const rate = rateKcal(goal.kgPerWeek);
  return { basis: { kind: 'computed', bmr: rest, weight, multiplier, tdee: total, rate }, kcal: Math.round(total + rate) };
}

/**
 * The target a goal sets on `date`: BMR from the weight trend that day, times the policy's
 * multiplier, plus the rate adjustment, plus the share of workouts the policy eats back. A
 * manual override replaces everything before the workouts and needs no profile. Null when
 * the goal cannot be computed yet.
 */
export function budgetFor(goal: Goal, facts: DayFacts, date: LocalDate): Budget | null {
  const { multiplier, workoutShare } = policyTerms(goal.policy);
  const base = baseFor(goal, facts, date, multiplier);
  if (base === null) return null;
  const fromWorkouts = Math.round(workoutShare * workoutKcal(facts.workouts));
  const kcal = base.kcal + fromWorkouts;
  return { basis: base.basis, baseKcal: base.kcal, workoutKcal: fromWorkouts, kcal, macros: macroGrams(goal.macros, kcal) };
}

/** The target on `date` from the goal in effect then, or null before any goal. */
export function budgetOn(input: DayFacts & { readonly goals: readonly Goal[]; readonly date: LocalDate }): Budget | null {
  const goal = goalOn(input.goals, input.date);
  return goal === undefined ? null : budgetFor(goal, input, input.date);
}

/** Kcal left for the day. Negative when over. */
export function remainingKcal(budget: Budget, eaten: Totals): number {
  return budget.kcal - eaten.sum.kcal;
}

/** The kcal that macro grams add up to. */
export function macroKcal(grams: Readonly<Record<Macro, number>>): number {
  return MACROS.reduce((sum, macro) => sum + grams[macro] * KCAL_PER_GRAM[macro], 0);
}
