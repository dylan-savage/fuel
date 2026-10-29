import { randomUUID } from 'node:crypto';
import { itemOf, type Entry } from '../src/domain/diary.js';
import type { Food } from '../src/domain/food.js';
import { goalId, type Goal, type Profile } from '../src/domain/goals.js';
import type { Fast, FastEnd, Water } from '../src/domain/habits.js';
import { EntryId, FoodId, LocalDate, Millis, type FastEndId, type FastId, type RecipeId, type SavedMealId, type WaterId } from '../src/domain/ids.js';
import type { Recipe, SavedMeal } from '../src/domain/reuse.js';
import { ClientId, MutationId, Rev, type SyncRequest, type WireMutation } from '../src/protocol.js';

export const newEntryId = (): EntryId => EntryId.parse(randomUUID());
export const newClientId = (): ClientId => ClientId.parse(randomUUID());
export const rev = (n: number): Rev => Rev.parse(n);
export const at = (ms: number): Millis => Millis.parse(ms);

export function entry(id: EntryId, kcal: number, date = '2026-10-28'): Entry {
  return {
    id,
    date: LocalDate.parse(date),
    meal: 'lunch',
    loggedAt: Millis.parse(1_800_000_000_000),
    food: { name: 'Quick add', unit: 'portion', nutrients: { kcal }, servings: [], origin: { kind: 'adhoc' } },
    quantity: { kind: 'amount', amount: 1 },
  };
}

export function food(id = FoodId.parse(randomUUID())): Food {
  return {
    id,
    name: 'Oats',
    unit: 'g',
    nutrients: { kcal: 380, protein: 13, carbs: 67, fat: 7 },
    servings: [{ label: '1 cup', amount: 80 }],
    barcodes: [],
    source: { kind: 'user' },
    archived: false,
  };
}

/** A goal effective from `date` with a manual target, so the simulation can tell versions apart. */
export function goal(date: LocalDate, kcal: number): Goal {
  return {
    id: goalId(date),
    effectiveFrom: date,
    policy: { kind: 'activity-level', level: 'moderate' },
    kgPerWeek: 0,
    kcalOverride: kcal,
    macros: { kind: 'grams', protein: 150, carbs: 200, fat: 60 },
  };
}

/** A one-ingredient recipe whose ingredient amount tells versions apart. */
export function recipe(id: RecipeId, grams: number): Recipe {
  const oats = food();
  return {
    id,
    name: 'Overnight oats',
    ingredients: [{ food: { ...oats, origin: { kind: 'food', id: oats.id } }, quantity: { kind: 'amount', amount: grams } }],
    yield: { servings: 2 },
    archived: false,
  };
}

export function savedMeal(id: SavedMealId, kcal: number): SavedMeal {
  return { id, name: 'Usual breakfast', items: [itemOf(entry(newEntryId(), kcal))], archived: false };
}

export function water(id: WaterId, ml: number): Water {
  return { id, date: LocalDate.parse('2026-10-28'), ml, loggedAt: Millis.parse(1_800_000_000_000) };
}

/** `hours` tells versions apart, as a changed target would. */
export function fast(id: FastId, hours: number): Fast {
  return { id, startedAt: Millis.parse(1_800_000_000_000), targetHours: hours };
}

export function fastEnd(id: FastEndId, fastId: FastId, n: number): FastEnd {
  return { id, fastId, endedAt: Millis.parse(1_800_000_000_000 + n * 60_000) };
}

export function profile(weightKg: number): Profile {
  return { id: 'me', sex: 'male', birthDate: LocalDate.parse('1990-06-15'), heightCm: 180, weightKg };
}

export const putEntry = (id: number, doc: Entry): WireMutation => ({
  op: 'put',
  id: MutationId.parse(id),
  kind: 'entry',
  docId: doc.id,
  doc,
});

export const deleteEntry = (id: number, docId: EntryId): WireMutation => ({
  op: 'delete',
  id: MutationId.parse(id),
  kind: 'entry',
  docId,
});

export function request(clientId: ClientId, mutations: WireMutation[], cursor = 0, epoch: string | null = null): SyncRequest {
  return { clientId, epoch, cursor: Rev.parse(cursor), mutations };
}
