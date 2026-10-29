import type { Meal } from '../../domain/diary.js';
import type { FoodSnapshot, Quantity, Serving } from '../../domain/food.js';
import { addDays, type LocalDate } from '../../domain/ids.js';
import type { FoodUnit } from '../../domain/units.js';

export const MEAL_LABEL: Readonly<Record<Meal, string>> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snacks: 'Snacks',
};

export const UNIT_LABEL: Readonly<Record<FoodUnit, string>> = { g: 'g', ml: 'ml', portion: 'portion' };

/** Per-basis label for nutrient values: "100 g", "100 ml", "1 portion". */
export const BASIS_LABEL: Readonly<Record<FoodUnit, string>> = { g: '100 g', ml: '100 ml', portion: '1 portion' };

export function kcal(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Whole numbers above 10, one decimal below, no trailing ".0". */
export function amount(n: number): string {
  const rounded = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** Accepts "1,5" as well as "1.5". Null for blank or non-numeric input. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The brand, unless the name already says it ("Coca-Cola" by Coca-Cola). */
export function brandOf(food: Pick<FoodSnapshot, 'name' | 'brand'>): string | undefined {
  return food.brand !== undefined && !food.name.toLowerCase().includes(food.brand.toLowerCase()) ? food.brand : undefined;
}

export function servingLabel(unit: FoodUnit, serving: Serving): string {
  const size = `${amount(serving.amount)} ${UNIT_LABEL[unit]}`;
  return serving.label.includes(size) || unit === 'portion' ? serving.label : `${serving.label} (${size})`;
}

export function quantityLabel(food: FoodSnapshot, q: Quantity): string {
  switch (q.kind) {
    case 'amount':
      return food.unit === 'portion' ? `${amount(q.amount)} ${q.amount === 1 ? 'portion' : 'portions'}` : `${amount(q.amount)} ${UNIT_LABEL[food.unit]}`;
    case 'serving':
      return q.count === 1 ? servingLabel(food.unit, q.serving) : `${amount(q.count)} × ${servingLabel(food.unit, q.serving)}`;
  }
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const RELATIVE_DAYS = [
  [0, 'today'],
  [-1, 'yesterday'],
  [1, 'tomorrow'],
] as const;

/** A day as it reads inside a sentence: "yesterday", or "Tue, Oct 27". */
export function dayPhrase(date: LocalDate, today: LocalDate): string {
  return RELATIVE_DAYS.find(([offset]) => addDays(today, offset) === date)?.[1] ?? WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

/** A day as a title: "Yesterday", or "Tue, Oct 27". */
export function dayTitle(date: LocalDate, today: LocalDate): string {
  const phrase = dayPhrase(date, today);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

/** "1 item", "3 items". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
