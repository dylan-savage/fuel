import { z } from 'zod';
import { todo } from '../todo.js';

/**
 * The one list of tracked nutrients. The schema below, the totals, the UI rows and the
 * external parsers all key off this object, so adding a nutrient is one edit plus the
 * compile errors it causes.
 */
export const NUTRIENTS = {
  kcal: { label: 'Calories', unit: 'kcal' },
  protein: { label: 'Protein', unit: 'g' },
  carbs: { label: 'Carbs', unit: 'g' },
  fat: { label: 'Fat', unit: 'g' },
  fiber: { label: 'Fiber', unit: 'g' },
  sugar: { label: 'Sugar', unit: 'g' },
  sodium: { label: 'Sodium', unit: 'mg' },
} as const;
export type NutrientKey = keyof typeof NUTRIENTS;

const amount = z.number().nonnegative().finite();

// `satisfies` makes the compiler reject a shape that drifts from NUTRIENTS.
const shape = {
  kcal: amount,
  protein: amount.optional(),
  carbs: amount.optional(),
  fat: amount.optional(),
  fiber: amount.optional(),
  sugar: amount.optional(),
  sodium: amount.optional(),
} satisfies Record<NutrientKey, z.ZodType>;

/**
 * Nutrients for some reference amount of a food. kcal is the one value every food must
 * know. Every other nutrient is undefined when unknown, never 0, so "unknown" and "none"
 * stay distinct.
 */
export const Nutrients = z.strictObject(shape);
export type Nutrients = z.infer<typeof Nutrients>;

/** Day, meal or recipe totals. Derived, never stored. */
export interface Totals {
  readonly sum: Readonly<Record<NutrientKey, number>>;
  /**
   * Nutrients that at least one contributor did not report. Missing values count as 0 in
   * `sum`, so for these keys `sum` is a lower bound and the UI prints "at least".
   */
  readonly incomplete: ReadonlySet<NutrientKey>;
}

/** Multiplies every known nutrient by factor. Unknown stays unknown. */
export function scale(n: Nutrients, factor: number): Nutrients {
  return todo(`scale(${JSON.stringify(n)}, ${factor})`);
}

/** Sums nutrients, treating unknown as 0 and recording it in `incomplete`. */
export function total(items: Iterable<Nutrients>): Totals {
  return todo(`total(${String(items)})`);
}

/**
 * Atwater estimate used by external parsers only when a source reports macros but no
 * energy. 4 kcal/g protein and carbs, 9 kcal/g fat.
 */
export function kcalFromMacros(protein: number, carbs: number, fat: number): number {
  return todo(`kcalFromMacros(${protein}, ${carbs}, ${fat})`);
}
