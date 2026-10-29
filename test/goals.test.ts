import { describe, expect, it } from 'vitest';
import {
  KG_PER_LB,
  ageOn,
  bmr,
  budgetFor,
  budgetOn,
  goalId,
  macroGrams,
  rateKcal,
  remainingKcal,
  type DayFacts,
  type Goal,
  type Profile,
} from '../src/domain/goals.js';
import { LocalDate, WorkoutId } from '../src/domain/ids.js';
import { parseDoc } from '../src/domain/kinds.js';
import { total } from '../src/domain/nutrients.js';
import { weighIn, workout } from './fixtures.js';

const day = (d: string) => LocalDate.parse(d);

const profile: Profile = { id: 'me', sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 };
const facts = (fields: Partial<DayFacts> = {}): DayFacts => ({ profile, weighIns: [], workouts: [], ...fields });
const runId = WorkoutId.parse('9f9e9d9c-9b9a-4998-9796-959493929190');

function goal(from: string, fields: Partial<Goal> = {}): Goal {
  return {
    id: goalId(day(from)),
    effectiveFrom: day(from),
    policy: { kind: 'activity-level', level: 'moderate' },
    kgPerWeek: -KG_PER_LB,
    macros: { kind: 'percent', protein: 30, carbs: 40, fat: 30 },
    ...fields,
  };
}

describe('Mifflin-St Jeor', () => {
  it('matches the published formula for a man and a woman', () => {
    expect(bmr({ sex: 'male', kg: 80, cm: 180, age: 30 })).toBe(1780);
    expect(bmr({ sex: 'female', kg: 60, cm: 165, age: 25 })).toBe(1345.25);
  });

  it('counts age in whole years, turning on the birthday', () => {
    expect(ageOn(day('1990-06-15'), day('2026-06-14'))).toBe(35);
    expect(ageOn(day('1990-06-15'), day('2026-06-15'))).toBe(36);
  });

  it('turns 1 lb a week into 500 kcal a day', () => {
    expect(rateKcal(-KG_PER_LB)).toBeCloseTo(-500);
    expect(rateKcal(0.5 * KG_PER_LB)).toBeCloseTo(250);
  });
});

describe('budgetFor', () => {
  it('sets the target to TDEE plus the rate and splits macros by percent', () => {
    // Age 36: BMR 10·81 + 6.25·180 − 5·36 + 5 = 1760. TDEE 1760 × 1.55 = 2728. Minus 500.
    const budget = budgetFor(goal('2026-10-01'), facts(), day('2026-10-28'));
    expect(budget?.kcal).toBe(2228);
    // 30% of 2228 / 4, 40% / 4, 30% / 9.
    expect(budget?.macros).toEqual({ protein: 167, carbs: 223, fat: 74 });
  });

  it('uses a manual override as the target, and needs no profile for it', () => {
    const manual = goal('2026-10-01', { kcalOverride: 1800, macros: { kind: 'grams', protein: 180, carbs: 150, fat: 55 } });
    expect(budgetFor(manual, facts({ profile: undefined }), day('2026-10-28'))).toEqual({
      basis: { kind: 'manual' },
      baseKcal: 1800,
      workoutKcal: 0,
      kcal: 1800,
      macros: { protein: 180, carbs: 150, fat: 55 },
    });
  });

  it('has no computed target until there is a profile', () => {
    expect(budgetFor(goal('2026-10-01'), facts({ profile: undefined }), day('2026-10-28'))).toBeNull();
    expect(budgetFor(goal('2026-10-01'), facts({ profile: undefined, weighIns: [weighIn('2026-10-28', 80)] }), day('2026-10-28'))).toBeNull();
  });
});

describe('BMR from the weight trend', () => {
  // Sedentary and maintaining, so the target is BMR × 1.2. Age 36 at 180 cm: BMR is 10 × kg + 940.
  const steady = goal('2026-10-01', { policy: { kind: 'activity-level', level: 'sedentary' }, kgPerWeek: 0 });
  const target = (date: string, weighIns: DayFacts['weighIns']) => budgetFor(steady, facts({ weighIns }), day(date))?.kcal;

  it('uses the trend weight on the day', () => {
    // 82 kg: (820 + 940) × 1.2.
    expect(target('2026-10-28', [weighIn('2026-10-28', 82)])).toBe(2124);
    // The trend, not the scale: 82 then 72 is a trend of 81 on the 2nd day.
    expect(target('2026-10-29', [weighIn('2026-10-28', 82), weighIn('2026-10-29', 72)])).toBe(2112);
  });

  it('keeps the profile weight on days before the first weigh-in, so they keep their targets', () => {
    expect(target('2026-10-27', [weighIn('2026-10-28', 70)])).toBe(2112);
  });

  it('moves a later day slightly when a late weigh-in fills a gap before it', () => {
    expect(target('2026-10-25', [weighIn('2026-10-20', 82)])).toBe(2124);
    expect(target('2026-10-25', [weighIn('2026-10-20', 82), weighIn('2026-10-24', 72)])).toBe(2112);
  });
});

describe('budget policies', () => {
  // A 30-minute run at 6 mph worked out at 80 kg: 8.8 × 80 × 0.5 = 352 kcal net.
  const run = workout(runId, 80);
  const eatBack = (fraction: number, fields: Partial<Goal> = {}) => goal('2026-10-01', { policy: { kind: 'eat-back-workouts', fraction }, ...fields });

  it('leaves the activity-level target alone when a workout is logged', () => {
    const budget = budgetFor(goal('2026-10-01'), facts({ workouts: [run] }), day('2026-10-28'));
    expect(budget).toMatchObject({ baseKcal: 2228, workoutKcal: 0, kcal: 2228 });
  });

  it('eats back the fraction of workout kcal on top of BMR × 1.2 plus the rate', () => {
    // 1760 × 1.2 − 500 = 1612.
    expect(budgetFor(eatBack(1), facts(), day('2026-10-28'))).toMatchObject({ baseKcal: 1612, workoutKcal: 0, kcal: 1612 });
    expect(budgetFor(eatBack(1), facts({ workouts: [run] }), day('2026-10-28'))).toMatchObject({ baseKcal: 1612, workoutKcal: 352, kcal: 1964 });
    expect(budgetFor(eatBack(0.5), facts({ workouts: [run, run] }), day('2026-10-28'))?.kcal).toBe(1612 + 352);
  });

  it('adds the burn stored at log time, even after the weight trend moves', () => {
    const lighter = facts({ workouts: [run], weighIns: [weighIn('2026-10-28', 60)] });
    expect(budgetFor(eatBack(1), lighter, day('2026-10-28'))?.workoutKcal).toBe(352);
  });

  it('eats back workouts on top of a manual target too', () => {
    expect(budgetFor(eatBack(1, { kcalOverride: 1800 }), facts({ workouts: [run] }), day('2026-10-28'))?.kcal).toBe(2152);
  });

  it('splits the eaten-back kcal into the percent macros', () => {
    // 30% of 1964 kcal at 4 kcal a gram.
    expect(budgetFor(eatBack(1), facts({ workouts: [run] }), day('2026-10-28'))?.macros.protein).toBe(147);
  });
});

describe('effective-dated goals', () => {
  const goals = [goal('2026-10-01', { kcalOverride: 2400 }), goal('2026-10-20', { kcalOverride: 2000 })];
  const target = (date: string) => budgetOn({ ...facts(), goals, date: day(date) })?.kcal;

  it('gives each day the goal in effect on it, so a new goal leaves past days alone', () => {
    expect(target('2026-09-30')).toBeUndefined();
    expect(target('2026-10-19')).toBe(2400);
    expect(target('2026-10-20')).toBe(2000);
    expect(target('2026-11-05')).toBe(2000);
  });
});

describe('remainingKcal', () => {
  it('subtracts every kcal eaten, quick adds with unknown macros included', () => {
    const eaten = total([{ kcal: 600, protein: 40, carbs: 50, fat: 20 }, { kcal: 850 }]);
    expect(remainingKcal({ basis: { kind: 'manual' }, baseKcal: 2000, workoutKcal: 0, kcal: 2000, macros: macroGrams(goal('2026-10-01').macros, 2000) }, eaten)).toBe(550);
  });
});

describe('goal documents', () => {
  it('reject an id that does not match the effective date', () => {
    expect(parseDoc('goal', goal('2026-10-01')).ok).toBe(true);
    expect(parseDoc('goal', { ...goal('2026-10-01'), id: 'g:2026-10-02' }).ok).toBe(false);
  });

  it('reject an eat-back fraction above 100%', () => {
    expect(parseDoc('goal', goal('2026-10-01', { policy: { kind: 'eat-back-workouts', fraction: 1 } })).ok).toBe(true);
    expect(parseDoc('goal', goal('2026-10-01', { policy: { kind: 'eat-back-workouts', fraction: 1.5 } })).ok).toBe(false);
  });

  it('reject a percent split that does not sum to 100', () => {
    expect(parseDoc('goal', goal('2026-10-01', { macros: { kind: 'percent', protein: 30, carbs: 40, fat: 20 } })).ok).toBe(false);
  });
});
