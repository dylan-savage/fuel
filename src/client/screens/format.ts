import type { Meal } from '../../domain/diary.js';
import { nutrientsFor, type FoodSnapshot, type Quantity, type Serving } from '../../domain/food.js';
import { KG_PER_LB } from '../../domain/goals.js';
import { ML_PER_FL_OZ } from '../../domain/habits.js';
import { addDays, type LocalDate } from '../../domain/ids.js';
import type { Target } from '../../domain/lifts.js';
import { MACROS, type Macro, type PartialNutrients } from '../../domain/nutrients.js';
import type { ChecklistBlock, DayPart } from '../../domain/program.js';
import type { FoodUnit } from '../../domain/units.js';
import { localDate } from '../clock.js';

export const MEAL_LABEL: Readonly<Record<Meal, string>> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snacks: 'Snacks',
};

export const MACRO_LABEL: Readonly<Record<Macro, string>> = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

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

/**
 * A number as a form field starts with it: exact and ungrouped, so saving an untouched
 * field writes back the same value. amount() is for display only; it rounds and groups.
 */
export function editable(n: number): string {
  return String(Number(n.toFixed(6)));
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

/** "1 slice (30 g)". A label that already gives its size keeps its own, which may be more exact than the rounded one. */
export function servingLabel(unit: FoodUnit, serving: Serving): string {
  const sized = new RegExp(`\\d\\s*${UNIT_LABEL[unit]}\\b`).test(serving.label);
  return sized || unit === 'portion' ? serving.label : `${serving.label} (${amount(serving.amount)} ${UNIT_LABEL[unit]})`;
}

export function quantityLabel(food: FoodSnapshot, q: Quantity): string {
  switch (q.kind) {
    case 'amount':
      return food.unit === 'portion' ? `${amount(q.amount)} ${q.amount === 1 ? 'portion' : 'portions'}` : `${amount(q.amount)} ${UNIT_LABEL[food.unit]}`;
    case 'serving':
      return q.count === 1 ? servingLabel(food.unit, q.serving) : `${amount(q.count)} × ${servingLabel(food.unit, q.serving)}`;
  }
}

/** A food in an amount as a row shows it: its name, its brand and amount, and its calories. */
export function foodRowParts(food: FoodSnapshot, quantity: Quantity): { readonly name: string; readonly detail: string; readonly end: string } {
  return { name: food.name, detail: [brandOf(food), quantityLabel(food, quantity)].filter(Boolean).join(' · '), end: kcal(nutrientsFor(food, quantity).kcal) };
}

/** "Protein 18 · Carbs 52 · Fat 11", with a dash for what the food does not say. */
export function macrosLine(values: Pick<PartialNutrients, Macro> | null): string {
  return MACROS.map((macro) => {
    const value = values?.[macro];
    return `${MACRO_LABEL[macro]} ${value === undefined ? '–' : amount(value)}`;
  }).join(' · ');
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

/** A body weight as a form field starts with it: lb to a tenth, ungrouped. */
export function lbField(kg: number): string {
  return editable(Math.round((kg / KG_PER_LB) * 10) / 10);
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

const SHORT_WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** "Mon". */
export function weekdayName(date: LocalDate): string {
  return SHORT_WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

const LONG_WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });

/** A past moment on the phone's clock: "Sunday 7:02 AM" within the last week, when a weekday is enough to place it, else "Mar 3, 7:02 AM". */
export function pastMoment(at: number, today: LocalDate): string {
  const date = localDate(new Date(at));
  return date > addDays(today, -7) ? `${LONG_WEEKDAY.format(new Date(at))} ${timeOfDay(at)}` : `${shortDate(date, today)}, ${timeOfDay(at)}`;
}

const PER_SIDE: Readonly<Record<NonNullable<Target['perSide']>, string>> = { 'left-first': 'Per side, left first', 'right-first': 'Per side, right first', either: 'Per side' };

const LOAD_NOTE: Readonly<Record<NonNullable<Target['load']>, string | null>> = { weight: null, bodyweight: 'Bodyweight', band: 'Band' };

const repRange = ({ reps }: Target) => (reps.min === reps.max ? `${reps.max}` : `${reps.min}–${reps.max}`);

/** "3 × 8–12". */
export function prescriptionText(target: Target): string {
  return `${target.sets} × ${repRange(target)}`;
}

/** What the prescription leaves unsaid: "Per side, left first", "Band". Each on its own line when opened. */
export function targetNotes({ perSide, load }: Target): readonly string[] {
  const note = load === undefined ? null : LOAD_NOTE[load];
  return [...(perSide === undefined ? [] : [PER_SIDE[perSide]]), ...(note === null ? [] : [note])];
}

/** "8–12 reps", "10 reps per side", "1 rep": a set's target, on the card. */
export function repsTargetText(target: Target): string {
  return `${repRange(target)} ${target.reps.max === 1 ? 'rep' : 'reps'}${target.perSide === undefined ? '' : ' per side'}`;
}

/** "Superset · 3 rounds · rest 60s". Null for anything that is not a superset, which has no heading. */
export function supersetLabel({ block, superset }: DayPart): string | null {
  if (block.kind !== 'lifts' || superset === null) return null;
  return [block.title ?? 'Superset', `${superset.rounds} rounds`, ...(block.restSeconds === undefined ? [] : [`rest ${block.restSeconds}s`])].join(' · ');
}

/** "Warm-up · 3 moves". */
export function checklistLabel({ title, items }: ChecklistBlock): string {
  return `${title ?? 'Checklist'} · ${count(items.length, 'move')}`;
}

/** One list of a day. `label` heads a superset, and is null for the rows between supersets. */
export interface PlanSection {
  readonly label: string | null;
  readonly parts: readonly DayPart[];
}

/** A day as its lists: a superset stands alone under its label, and everything between supersets shares one list. */
export function planSections(parts: readonly DayPart[]): readonly PlanSection[] {
  const sections: PlanSection[] = [];
  for (const part of parts) {
    const label = supersetLabel(part);
    const last = sections.at(-1);
    if (label === null && last !== undefined && last.label === null) sections.splice(-1, 1, { label: null, parts: [...last.parts, part] });
    else sections.push({ label, parts: [part] });
  }
  return sections;
}

/** "Rest 0:48", then past zero, counting up, "Rest +0:12". */
export function restText(endsAt: number, now: number): string {
  const left = endsAt - now;
  const seconds = left > 0 ? Math.ceil(left / 1000) : Math.floor(-left / 1000);
  return `Rest ${left > 0 || seconds === 0 ? '' : '+'}${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

/** The start of a long text, cut at a word. Null when the whole text fits. */
export function clipped(text: string, limit: number): string | null {
  if (text.length <= limit) return null;
  const start = text.slice(0, limit);
  const word = start.search(/\s\S*$/);
  return `${word > 0 ? start.slice(0, word) : start}…`;
}
