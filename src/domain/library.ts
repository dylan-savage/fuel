import type { Entry, Meal } from './diary.js';
import { snapshotOf, type Food, type FoodSnapshot, type Quantity } from './food.js';
import type { FoodId, Millis } from './ids.js';

/** How far back recents look. */
export const RECENT_DAYS = 90;
const DAY_MS = 86_400_000;
/** A use counts half as much after a week, so staples outrank one-offs and old habits fade. */
const HALF_LIFE_DAYS = 7;

/** Something Dylan can log in one tap: a food as it is now, in the amount he used last time. */
export interface RecentFood {
  readonly key: string;
  readonly food: FoodSnapshot;
  readonly lastQuantity: Quantity;
  readonly lastMeal: Meal;
  readonly lastLoggedAt: Millis;
}

/** A local search result. Library foods never logged have no last quantity. */
export interface LocalHit {
  readonly key: string;
  readonly food: FoodSnapshot;
  readonly lastQuantity: Quantity | undefined;
}

/** Lowercase with accents folded, so "creme" finds "Crème fraîche". */
export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** One key per food across re-logs: the library id, or the name and brand of a one-off. */
export function foodKey(food: FoodSnapshot): string {
  return food.origin.kind === 'food' ? `food:${food.origin.id}` : `adhoc:${normalize(food.name)}|${normalize(food.brand ?? '')}`;
}

/** The snapshot to offer now: the library food's current version, or nothing once it is archived. */
function current(snapshot: FoodSnapshot, library: ReadonlyMap<FoodId, Food>): FoodSnapshot | null {
  if (snapshot.origin.kind !== 'food') return snapshot;
  const food = library.get(snapshot.origin.id);
  if (food === undefined) return snapshot;
  return food.archived ? null : snapshotOf(food);
}

/**
 * Foods from these entries, most used first with recency decay, each with the quantity and
 * meal of its latest use. Pure and local, so the list is instant and works offline.
 */
export function recents(input: {
  readonly entries: readonly Entry[];
  readonly library: ReadonlyMap<FoodId, Food>;
  readonly now: Millis;
  readonly limit: number;
}): RecentFood[] {
  const groups = new Map<string, { latest: Entry; score: number }>();
  for (const entry of input.entries) {
    const key = foodKey(entry.food);
    const weight = 0.5 ** (Math.max(0, input.now - entry.loggedAt) / DAY_MS / HALF_LIFE_DAYS);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { latest: entry, score: weight });
    } else {
      group.score += weight;
      if (entry.loggedAt > group.latest.loggedAt) group.latest = entry;
    }
  }
  return [...groups]
    .flatMap(([key, { latest, score }]) => {
      const food = current(latest.food, input.library);
      return food === null ? [] : [{ key, score, recent: { key, food, lastQuantity: latest.quantity, lastMeal: latest.meal, lastLoggedAt: latest.loggedAt } }];
    })
    .toSorted((a, b) => b.score - a.score || b.recent.lastLoggedAt - a.recent.lastLoggedAt)
    .slice(0, input.limit)
    .map(({ recent }) => recent);
}

/** Every query word starts a word of the food's name or brand. */
export function matches(food: FoodSnapshot, query: string): boolean {
  const words = normalize(`${food.name} ${food.brand ?? ''}`).split(/[^\p{L}\p{N}]+/u);
  return normalize(query)
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => words.some((w) => w.startsWith(word)));
}

/** Recent then library foods matching the query, recents in use order. Instant and offline. */
export function searchLocal(input: {
  readonly query: string;
  readonly library: readonly Food[];
  readonly recents: readonly RecentFood[];
  readonly limit: number;
}): LocalHit[] {
  const hits = new Map<string, LocalHit>();
  for (const recent of input.recents) {
    if (matches(recent.food, input.query)) hits.set(recent.key, { key: recent.key, food: recent.food, lastQuantity: recent.lastQuantity });
  }
  const library = input.library.filter((food) => !food.archived).toSorted((a, b) => a.name.localeCompare(b.name));
  for (const food of library) {
    const snapshot = snapshotOf(food);
    const key = foodKey(snapshot);
    if (!hits.has(key) && matches(snapshot, input.query)) hits.set(key, { key, food: snapshot, lastQuantity: undefined });
  }
  return [...hits.values()].slice(0, input.limit);
}
