import { z } from 'zod';

/**
 * The one list of tracked nutrients. The schemas, totals and UI rows all key off it.
 * `core` nutrients are the ones every library food must know.
 */
export const NUTRIENTS = [
  { key: 'kcal', label: 'Calories', unit: 'kcal', core: true },
  { key: 'protein', label: 'Protein', unit: 'g', core: true },
  { key: 'carbs', label: 'Carbs', unit: 'g', core: true },
  { key: 'fat', label: 'Fat', unit: 'g', core: true },
  { key: 'fiber', label: 'Fiber', unit: 'g', core: false },
  { key: 'sugar', label: 'Sugar', unit: 'g', core: false },
  { key: 'sodium', label: 'Sodium', unit: 'mg', core: false },
] as const;
export type NutrientKey = (typeof NUTRIENTS)[number]['key'];
export type CoreKey = Extract<(typeof NUTRIENTS)[number], { core: true }>['key'];

export const CORE_KEYS: readonly CoreKey[] = NUTRIENTS.flatMap((n) => (n.core ? [n.key] : []));

/** Energy per gram of each macro (Atwater general factors). */
export const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const satisfies Partial<Record<CoreKey, number>>;
export type Macro = keyof typeof KCAL_PER_GRAM;
export const MACROS: readonly Macro[] = ['protein', 'carbs', 'fat'];

const amount = z.number().nonnegative().finite();

/**
 * Any subset known. Unknown is absent, never 0, so "unknown" and "none" stay distinct.
 * Loose, like every document shape: a nutrient a newer app adds survives an older app's
 * rewrite instead of being stripped.
 */
export const PartialNutrients = z.looseObject({
  kcal: amount.optional(),
  protein: amount.optional(),
  carbs: amount.optional(),
  fat: amount.optional(),
  fiber: amount.optional(),
  sugar: amount.optional(),
  sodium: amount.optional(),
} satisfies Record<NutrientKey, z.ZodType>);
export type PartialNutrients = z.infer<typeof PartialNutrients>;

/** What a diary entry needs. A quick add knows only kcal. */
export const Nutrients = PartialNutrients.required({ kcal: true });
export type Nutrients = z.infer<typeof Nutrients>;

/** What a library food needs: every core nutrient. */
export const FoodNutrients = PartialNutrients.required({
  kcal: true,
  protein: true,
  carbs: true,
  fat: true,
} as const satisfies Record<CoreKey, true>);
export type FoodNutrients = z.infer<typeof FoodNutrients>;

/** Day, meal or recipe totals. Derived, never stored. */
export interface Totals {
  readonly sum: Readonly<Record<NutrientKey, number>>;
  /**
   * Nutrients at least one item did not report. For these keys `sum` is a lower bound
   * ("protein: at least 92 g"), and a recipe must treat them as unknown.
   */
  readonly incomplete: ReadonlySet<NutrientKey>;
}

/** Multiplies every known nutrient by factor. Unknown stays unknown. */
export function scale(n: Nutrients, factor: number): Nutrients {
  const out: PartialNutrients = {};
  for (const { key } of NUTRIENTS) {
    const value = n[key];
    if (value !== undefined) out[key] = value * factor;
  }
  return { ...out, kcal: n.kcal * factor };
}

export function total(items: Iterable<PartialNutrients>): Totals {
  const sum: Record<NutrientKey, number> = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  const incomplete = new Set<NutrientKey>();
  for (const item of items) {
    for (const { key } of NUTRIENTS) {
      const value = item[key];
      if (value === undefined) incomplete.add(key);
      else sum[key] += value;
    }
  }
  return { sum, incomplete };
}
