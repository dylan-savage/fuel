import { z } from 'zod';
import { defaultQuantity, type FoodSnapshot, type Ingredient, type Quantity, type Serving } from './food.js';
import { foodKey, offers, searchLocal, type Library, type LocalHit, type RecentFood } from './library.js';
import { FoodNutrients, scale } from './nutrients.js';
import { BASIS, type FoodUnit } from './units.js';

const TEXT_MAX = 120;

/** One of Dylan's foods as the model sees it: a name to read and a key to answer with. */
export const FoodHint = z.object({
  key: z.string().min(1).max(200),
  name: z.string().min(1).max(TEXT_MAX),
  brand: z.string().min(1).max(TEXT_MAX).optional(),
});
export type FoodHint = z.infer<typeof FoodHint>;

export const MAX_HINTS = 60;

const positive = z.number().positive().finite();

export const DraftAmount = z.object({
  /** As described or seen: "2 large", "about a cup". */
  described: z.string().max(TEXT_MAX),
  count: positive.nullable(),
  /** One counted piece, singular: "egg", "slice". */
  countUnit: z.string().min(1).max(40).nullable(),
  grams: positive.nullable(),
  ml: positive.nullable(),
});
export type DraftAmount = z.infer<typeof DraftAmount>;

export const Confidence = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof Confidence>;

/** One food the model found in a description or a plate photo. */
export const Draft = z.object({
  name: z.string().min(1).max(TEXT_MAX),
  brand: z.string().min(1).max(TEXT_MAX).optional(),
  amount: DraftAmount,
  /** For the whole amount, not per 100 g. */
  nutrients: FoodNutrients,
  confidence: Confidence,
  /** The key of the hint the model judged this item to be. */
  match: z.string().nullable(),
});
export type Draft = z.infer<typeof Draft>;

const clip = (text: string) => text.slice(0, TEXT_MAX);

/** Dylan's foods for the model to match against: what he logs most first, then the rest of the library. */
export function foodHints(input: { readonly recents: readonly RecentFood[]; readonly library: Library; readonly limit: number }): FoodHint[] {
  const hints = new Map<string, FoodHint>();
  const add = (key: string, food: FoodSnapshot) => {
    if (hints.has(key) || hints.size >= input.limit) return;
    hints.set(key, { key, name: clip(food.name), ...(food.brand === undefined ? {} : { brand: clip(food.brand) }) });
  };
  for (const recent of input.recents) add(recent.key, recent.food);
  for (const food of offers(input.library)) add(foodKey(food), food);
  return [...hints.values()];
}

const CHOICES = 3;

function yours(input: { readonly recents: readonly RecentFood[]; readonly library: Library }): LocalHit[] {
  return [
    ...input.recents.map((recent): LocalHit => ({ key: recent.key, food: recent.food, lastQuantity: recent.lastQuantity })),
    ...offers(input.library).map((food): LocalHit => ({ key: foodKey(food), food, lastQuantity: undefined })),
  ];
}

/** Dylan's foods a draft could log as: the model's match first, then foods whose name the draft's name finds. */
export function choicesFor(draft: Draft, input: { readonly recents: readonly RecentFood[]; readonly library: Library }): LocalHit[] {
  const matched = draft.match === null ? undefined : yours(input).find((hit) => hit.key === draft.match);
  const named = searchLocal({ query: draft.name, library: input.library, recents: input.recents, limit: CHOICES });
  const choices = matched === undefined ? named : [matched, ...named.filter((hit) => hit.key !== matched.key)];
  return choices.slice(0, CHOICES);
}

const SERVING_TOLERANCE = 0.35;
const servingMatches = (servingTotal: number, measured: number) => Math.abs(servingTotal - measured) <= SERVING_TOLERANCE * measured;

/**
 * How much of one of Dylan's foods the draft describes, in that food's unit. With no amount
 * stated ("my usual oats") it is what he logged last time. Grams and millilitres never convert.
 */
export function quantityFor(amount: DraftAmount, food: Pick<FoodSnapshot, 'unit' | 'servings'>, usual: Quantity | undefined): Quantity {
  const fallback = usual ?? defaultQuantity(food);
  const { count } = amount;
  if (food.unit === 'portion') return count === null ? fallback : { kind: 'amount', amount: count };
  const measured = food.unit === 'g' ? amount.grams : amount.ml;
  const [serving] = food.servings;
  if (serving !== undefined && count !== null && (measured === null || servingMatches(serving.amount * count, measured))) {
    return { kind: 'serving', serving, count };
  }
  return measured === null ? fallback : { kind: 'amount', amount: measured };
}

/**
 * The draft as the AI estimated it, a one-off food. Measured by weight or volume when the
 * model gave one, so changing the amount scales the nutrients; a counted piece becomes a
 * serving, so "3 slices" can become 2.
 */
export function estimateItem(draft: Draft): Ingredient {
  const { amount } = draft;
  const { unit, size }: { readonly unit: FoodUnit; readonly size: number } =
    amount.grams !== null
      ? { unit: 'g', size: amount.grams }
      : amount.ml !== null
        ? { unit: 'ml', size: amount.ml }
        : { unit: 'portion', size: amount.count ?? 1 };
  const serving: Serving | null = amount.count === null || amount.countUnit === null ? null : { label: `1 ${amount.countUnit}`, amount: size / amount.count };
  const food: FoodSnapshot = {
    name: draft.name,
    ...(draft.brand === undefined ? {} : { brand: draft.brand }),
    unit,
    nutrients: scale(draft.nutrients, BASIS[unit] / size),
    servings: serving === null ? [] : [serving],
    origin: { kind: 'adhoc' },
  };
  const quantity: Quantity = serving === null || amount.count === null ? { kind: 'amount', amount: size } : { kind: 'serving', serving, count: amount.count };
  return { food, quantity };
}

/** What a draft logs as: one of Dylan's foods in the draft's amount, or the AI's estimate. */
export function draftItem(draft: Draft, choice: LocalHit | null): Ingredient {
  if (choice === null) return estimateItem(draft);
  return { food: choice.food, quantity: quantityFor(draft.amount, choice.food, choice.lastQuantity) };
}
