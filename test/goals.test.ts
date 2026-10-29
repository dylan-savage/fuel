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
  tdee,
  type Goal,
  type Profile,
} from '../src/domain/goals.js';
import { LocalDate } from '../src/domain/ids.js';
import { parseDoc } from '../src/domain/kinds.js';
import { total } from '../src/domain/nutrients.js';

const day = (d: string) => LocalDate.parse(d);

const profile: Profile = { id: 'me', sex: 'male', birthDate: day('1990-06-15'), heightCm: 180, weightKg: 81 };

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

  it('multiplies BMR by the activity level for TDEE', () => {
    expect(tdee(1780, 'sedentary')).toBeCloseTo(2136);
    expect(tdee(1780, 'moderate')).toBeCloseTo(2759);
  });

  it('turns 1 lb a week into 500 kcal a day', () => {
    expect(rateKcal(-KG_PER_LB)).toBeCloseTo(-500);
    expect(rateKcal(0.5 * KG_PER_LB)).toBeCloseTo(250);
  });
});

describe('budgetFor', () => {
  it('sets the target to TDEE plus the rate and splits macros by percent', () => {
    // Age 36: BMR 10·81 + 6.25·180 − 5·36 + 5 = 1760. TDEE 1760 × 1.55 = 2728. Minus 500.
    const budget = budgetFor(goal('2026-10-01'), profile, day('2026-10-28'));
    expect(budget?.kcal).toBe(2228);
    // 30% of 2228 / 4, 40% / 4, 30% / 9.
    expect(budget?.macros).toEqual({ protein: 167, carbs: 223, fat: 74 });
  });

  it('uses a manual override as the target, and needs no profile for it', () => {
    const manual = goal('2026-10-01', { kcalOverride: 1800, macros: { kind: 'grams', protein: 180, carbs: 150, fat: 55 } });
    expect(budgetFor(manual, undefined, day('2026-10-28'))).toEqual({
      basis: { kind: 'manual' },
      kcal: 1800,
      macros: { protein: 180, carbs: 150, fat: 55 },
    });
  });

  it('has no computed target until there is a profile', () => {
    expect(budgetFor(goal('2026-10-01'), undefined, day('2026-10-28'))).toBeNull();
  });
});

describe('effective-dated goals', () => {
  const goals = [goal('2026-10-01', { kcalOverride: 2400 }), goal('2026-10-20', { kcalOverride: 2000 })];
  const target = (date: string) => budgetOn({ goals, profile, date: day(date) })?.kcal;

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
    expect(remainingKcal({ basis: { kind: 'manual' }, kcal: 2000, macros: macroGrams(goal('2026-10-01').macros, 2000) }, eaten)).toBe(550);
  });
});

describe('goal documents', () => {
  it('reject an id that does not match the effective date', () => {
    expect(parseDoc('goal', goal('2026-10-01')).ok).toBe(true);
    expect(parseDoc('goal', { ...goal('2026-10-01'), id: 'g:2026-10-02' }).ok).toBe(false);
  });

  it('reject a percent split that does not sum to 100', () => {
    expect(parseDoc('goal', goal('2026-10-01', { macros: { kind: 'percent', protein: 30, carbs: 40, fat: 20 } })).ok).toBe(false);
  });
});
