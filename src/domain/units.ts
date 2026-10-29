import { z } from 'zod';

/**
 * The unit a food is measured in. 'portion' is for things with no known weight (a
 * restaurant item, a quick add). Grams and millilitres never convert into each other.
 */
export const FoodUnit = z.enum(['g', 'ml', 'portion']);
export type FoodUnit = z.infer<typeof FoodUnit>;

/**
 * How many units a food's nutrients describe. Fixed by the unit, so a food cannot carry a
 * basis that disagrees with its unit.
 */
export const BASIS: Readonly<Record<FoodUnit, number>> = { g: 100, ml: 100, portion: 1 };
