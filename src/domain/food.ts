import { z } from 'zod';
import { FoodId, Millis } from './ids.js';
import { CORE_KEYS, FoodNutrients, Nutrients, PartialNutrients, scale, type CoreKey } from './nutrients.js';
import { BASIS, FoodUnit } from './units.js';

/** GS1 mod-10: weights 3, 1, 3, ... from the digit left of the check digit. */
function hasValidCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) {
    sum += Number(digits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/**
 * A product barcode normalized to 13 digits with a verified check digit, so one product has
 * one key whichever symbology the decoder reported.
 */
export const Gtin = z
  .string()
  .regex(/^\d{13}$/)
  .refine(hasValidCheckDigit, 'invalid check digit')
  .brand<'Gtin'>();
export type Gtin = z.infer<typeof Gtin>;

/** The symbologies printed on retail food, named as BarcodeDetector reports them. */
export const RetailFormat = z.enum(['ean_13', 'upc_a', 'ean_8', 'upc_e']);
export type RetailFormat = z.infer<typeof RetailFormat>;

/** An 8-digit UPC-E is a zero-suppressed UPC-A, so it expands rather than pads. */
function expandUpcE(upcE: string): string | null {
  if (!/^[01]\d{7}$/.test(upcE)) return null;
  const [ns, d1, d2, d3, d4, d5, d6, check] = upcE;
  const body =
    d6 === '0' || d6 === '1' || d6 === '2'
      ? `${d1}${d2}${d6}0000${d3}${d4}${d5}`
      : d6 === '3'
        ? `${d1}${d2}${d3}00000${d4}${d5}`
        : d6 === '4'
          ? `${d1}${d2}${d3}${d4}00000${d5}`
          : `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${ns}${body}${check}`;
}

/**
 * Normalizes a decoded retail barcode. Decoders disagree on the digits they report (zxing
 * gives UPC-A and UPC-E as 13 digits; others give 12 and 8), so any length a GTIN can
 * take is accepted and the check digit decides. Null for anything else.
 */
export function parseGtin(format: string, raw: string): Gtin | null {
  if (!RetailFormat.safeParse(format).success || !/^\d+$/.test(raw)) return null;
  const digits = format === 'upc_e' && raw.length === 8 ? expandUpcE(raw) : raw;
  if (digits === null || ![8, 12, 13].includes(digits.length)) return null;
  const parsed = Gtin.safeParse(digits.padStart(13, '0'));
  return parsed.success ? parsed.data : null;
}

/** A named serving whose amount is in the owning food's unit ("1 large egg" is 50 g). */
export const Serving = z.looseObject({
  label: z.string().min(1),
  amount: z.number().positive(),
});
export type Serving = z.infer<typeof Serving>;

/**
 * How much was eaten. A serving quantity carries a copy of the serving, so it resolves
 * without a lookup and cannot dangle.
 */
export const Quantity = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('amount'), amount: z.number().positive() }),
  z.looseObject({ kind: z.literal('serving'), serving: Serving, count: z.number().positive() }),
]);
export type Quantity = z.infer<typeof Quantity>;

/** Provenance of a snapshot, for grouping recents. Never read by nutrient math. */
export const Origin = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('food'), id: FoodId }),
  z.looseObject({ kind: z.literal('adhoc') }),
]);
export type Origin = z.infer<typeof Origin>;

/**
 * A food's nutrition at one moment, held by value in entries, so editing the library food
 * later never changes a past day. `nutrients` describe BASIS[unit] units.
 */
export const FoodSnapshot = z.looseObject({
  name: z.string().min(1),
  brand: z.string().min(1).optional(),
  unit: FoodUnit,
  nutrients: Nutrients,
  servings: z.array(Serving),
  origin: Origin,
});
export type FoodSnapshot = z.infer<typeof FoodSnapshot>;

/** A food's key in USDA FoodData Central. */
export const FdcId = z.number().int().positive();

export const FoodSource = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('user') }),
  z.looseObject({ kind: z.literal('off'), gtin: Gtin, fetchedAt: Millis }),
  z.looseObject({ kind: z.literal('usda'), fdcId: FdcId }),
  z.looseObject({ kind: z.literal('ai'), from: z.enum(['label', 'plate', 'text']) }),
]);
export type FoodSource = z.infer<typeof FoodSource>;

/** A food in Dylan's library. Archived, never deleted, so provenance stays meaningful. */
export const Food = FoodSnapshot.omit({ origin: true, nutrients: true }).extend({
  id: FoodId,
  nutrients: FoodNutrients,
  barcodes: z.array(Gtin),
  source: FoodSource,
  archived: z.boolean(),
});
export type Food = z.infer<typeof Food>;

/**
 * External or AI data not yet in the library. Any nutrient may be missing; completeFood is
 * the only way to a Food, so an incomplete import cannot reach the diary.
 */
export const FoodCandidate = Food.omit({ id: true, archived: true, nutrients: true }).extend({
  nutrients: PartialNutrients,
});
export type FoodCandidate = z.infer<typeof FoodCandidate>;

export type Completion = { readonly ok: true; readonly food: Food } | { readonly ok: false; readonly missing: readonly CoreKey[] };

/** The core nutrients a library food needs and these nutrients lack. */
export function missingCore(nutrients: PartialNutrients): CoreKey[] {
  return CORE_KEYS.filter((key) => nutrients[key] === undefined);
}

/** A Food, or the core nutrients the confirm sheet must ask for. */
export function completeFood(candidate: FoodCandidate, id: FoodId): Completion {
  const nutrients = FoodNutrients.safeParse(candidate.nutrients);
  if (!nutrients.success) return { ok: false, missing: missingCore(candidate.nutrients) };
  return { ok: true, food: { ...candidate, id, nutrients: nutrients.data, archived: false } };
}

/** What an entry holds of a library food: its nutrition now, pointing back at the food. */
export function snapshotOf(food: Food): FoodSnapshot {
  const { name, brand, unit, nutrients, servings } = food;
  return { name, ...(brand === undefined ? {} : { brand }), unit, nutrients, servings, origin: { kind: 'food', id: food.id } };
}

/** A food in an external database, by its key there. */
export const ExternalRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gtin'), gtin: Gtin }),
  z.object({ kind: z.literal('usda'), fdcId: FdcId }),
]);
export type ExternalRef = z.infer<typeof ExternalRef>;

/**
 * One external search result. The candidate is what the search payload carried; looking up
 * `ref` can add servings the search payload leaves out.
 */
export const SearchHit = z.object({ ref: ExternalRef, candidate: FoodCandidate });
export type SearchHit = z.infer<typeof SearchHit>;

/** A food plus how much of it: what logging takes. */
export const Ingredient = z.looseObject({ food: FoodSnapshot, quantity: Quantity });
export type Ingredient = z.infer<typeof Ingredient>;

/** Amount of a quantity in the food's unit. */
function baseAmount(q: Quantity): number {
  switch (q.kind) {
    case 'amount':
      return q.amount;
    case 'serving':
      return q.serving.amount * q.count;
  }
}

/** The only food-times-quantity formula in the system. */
export function nutrientsFor(food: FoodSnapshot, q: Quantity): Nutrients {
  return scale(food.nutrients, baseAmount(q) / BASIS[food.unit]);
}

/** A one-off item ("restaurant dinner, 850 kcal"). Only kcal is required. */
export function quickAddItem(label: string, nutrients: Nutrients): Ingredient {
  return {
    food: { name: label.trim() || 'Quick add', unit: 'portion', nutrients, servings: [], origin: { kind: 'adhoc' } },
    quantity: { kind: 'amount', amount: 1 },
  };
}
