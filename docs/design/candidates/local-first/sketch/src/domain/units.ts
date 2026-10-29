import { z } from 'zod';
import { todo } from '../todo.js';

/** Body mass. Stored canonical metric. The UI converts to lb at the edge using Profile.display. */
export const Kg = z.number().positive().max(400).brand<'Kg'>();
export type Kg = z.infer<typeof Kg>;

/** Food or burn energy in kilocalories (the "Calories" on US labels). */
export const Kcal = z.number().finite().brand<'Kcal'>();
export type Kcal = z.infer<typeof Kcal>;

/** Energy per kg of body-mass change, used for goal rates and adaptive TDEE. */
export const KCAL_PER_KG = 7700;

export function lbToKg(lb: number): Kg {
  return todo(`lbToKg(${lb})`);
}
export function kgToLb(kg: Kg): number {
  return todo(`kgToLb(${kg})`);
}
export function kjToKcal(kj: number): number {
  return todo(`kjToKcal(${kj})`);
}
export function flOzToMl(flOz: number): number {
  return todo(`flOzToMl(${flOz})`);
}
