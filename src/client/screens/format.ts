import type { Meal } from '../../domain/diary.js';
import type { FoodSnapshot, Quantity, Serving } from '../../domain/food.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { ML_PER_FL_OZ } from '../../domain/habits.js';
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

/** Water is stored in ml and shown in US fluid ounces, like weight in lb. */
export function flOz(ml: number): string {
  return amount(ml / ML_PER_FL_OZ);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A running timer: "13:24:05". */
export function stopwatch(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${pad2(Math.floor((seconds % 3600) / 60))}:${pad2(seconds % 60)}`;
}

/** A finished length: "16 h 12 m", "45 m". */
export function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} m`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} m`;
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** "8:12 PM" on the phone's clock. */
export function timeOfDay(at: number): string {
  return TIME.format(new Date(at));
}

/** A fasting target the way it is usually named: "16:8", or "24 h" for a whole day. */
export function fastLabel(hours: number): string {
  return hours < 24 && Number.isInteger(hours) ? `${hours}:${24 - hours}` : `${amount(hours)} h`;
}

const TENTHS = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;

/** Body weight is stored in kg and shown in lb, to a tenth: "178.4". */
export function lb(kg: number): string {
  return (kg / KG_PER_LB).toLocaleString('en-US', TENTHS);
}

/** A weekly change as it reads on screen: "−1.2 lb a week", "+0.4 lb a week". */
export function lbPerWeek(kgPerWeek: number): string {
  const pounds = Math.abs(kgPerWeek / KG_PER_LB).toLocaleString('en-US', TENTHS);
  return `${kgPerWeek < 0 ? '−' : '+'}${pounds} lb a week`;
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const FULL_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "Oct 27", with the year when it is not this year's: "Mar 4, 2027". */
export function shortDate(date: LocalDate, today: LocalDate): string {
  const at = new Date(`${date}T00:00:00Z`);
  return date.slice(0, 4) === today.slice(0, 4) ? SHORT_DATE.format(at) : FULL_DATE.format(at);
}
