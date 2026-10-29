import type { Entry, Meal } from './diary.js';
import { defaultQuantity, snapshotOf, type ExternalRef, type Food, type FoodCandidate, type FoodSnapshot, type Quantity, type SearchHit } from './food.js';
import type { FoodId, Millis, RecipeId } from './ids.js';
import { recipeSnapshot, type Recipe } from './reuse.js';

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

/** Dylan's foods and recipes: everything that has a current version to offer. */
export interface Library {
  readonly foods: readonly Food[];
  readonly recipes: readonly Recipe[];
}

/** One key per food across re-logs: the library id, or the name and brand of a one-off. */
export function foodKey(food: FoodSnapshot): string {
  const { origin } = food;
  switch (origin.kind) {
    case 'food':
      return `food:${origin.id}`;
    case 'recipe':
      return `recipe:${origin.id}`;
    case 'adhoc':
      return `adhoc:${normalize(food.name)}|${normalize(food.brand ?? '')}`;
  }
}

interface LibraryIndex {
  readonly foods: ReadonlyMap<FoodId, Food>;
  readonly recipes: ReadonlyMap<RecipeId, Recipe>;
}

/** The snapshot to offer now: the food's or recipe's current version, or nothing once it is archived. */
function current(snapshot: FoodSnapshot, index: LibraryIndex): FoodSnapshot | null {
  const { origin } = snapshot;
  switch (origin.kind) {
    case 'adhoc':
      return snapshot;
    case 'food': {
      const food = index.foods.get(origin.id);
      if (food === undefined) return snapshot;
      return food.archived ? null : snapshotOf(food);
    }
    case 'recipe': {
      const recipe = index.recipes.get(origin.id);
      if (recipe === undefined) return snapshot;
      return recipe.archived ? null : recipeSnapshot(recipe);
    }
  }
}

/** Every live food and recipe as a snapshot to log, by name. */
export function offers(library: Library): FoodSnapshot[] {
  return [...library.foods.filter((f) => !f.archived).map(snapshotOf), ...library.recipes.filter((r) => !r.archived).map(recipeSnapshot)].toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );
}

/**
 * Foods from these entries, most used first with recency decay, each with the quantity and
 * meal of its latest use. Pure and local, so the list is instant and works offline. A food
 * now measured in another unit starts from its default amount, since the old one would
 * change meaning.
 */
export function recents(input: {
  readonly entries: readonly Entry[];
  readonly library: Library;
  readonly now: Millis;
  readonly limit: number;
}): RecentFood[] {
  const index: LibraryIndex = {
    foods: new Map(input.library.foods.map((f) => [f.id, f])),
    recipes: new Map(input.library.recipes.map((r) => [r.id, r])),
  };
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
      const food = current(latest.food, index);
      if (food === null) return [];
      const lastQuantity = food.unit === latest.food.unit ? latest.quantity : defaultQuantity(food);
      return [{ key, score, recent: { key, food, lastQuantity, lastMeal: latest.meal, lastLoggedAt: latest.loggedAt } }];
    })
    .toSorted((a, b) => b.score - a.score || b.recent.lastLoggedAt - a.recent.lastLoggedAt)
    .slice(0, input.limit)
    .map(({ recent }) => recent);
}

const wordsOf = (text: string): string[] => normalize(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');

/** Every query word starts a word of the name or brand. */
export function matches(food: Pick<FoodSnapshot, 'name' | 'brand'>, query: string): boolean {
  const words = wordsOf(`${food.name} ${food.brand ?? ''}`);
  return wordsOf(query).every((word) => words.some((w) => w.startsWith(word)));
}

/** "bananas" also finds "banana": a plural query should not miss a singular name. */
const singular = (word: string): string => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

const compareKeys = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * Hits best match first: every query word found, then a name that leads with the first query
 * word, then fewer words, so "Bananas, raw" beats "Bananas, dehydrated, or banana powder".
 * Ties keep the source's order.
 */
export function rankByName<T extends { readonly candidate: Pick<FoodCandidate, 'name'> }>(hits: readonly T[], query: string): T[] {
  const terms = wordsOf(query).map(singular);
  const first = terms[0];
  return hits
    .map((hit, index) => {
      const words = wordsOf(hit.candidate.name);
      const missing = terms.filter((term) => !words.some((w) => w.startsWith(term))).length;
      const leads = first !== undefined && words[0]?.startsWith(first) === true ? 0 : 1;
      return { hit, key: [missing, leads, words.length, index] };
    })
    .toSorted((a, b) => compareKeys(a.key, b.key))
    .map(({ hit }) => hit);
}

const refKey = (ref: ExternalRef): string => (ref.kind === 'gtin' ? `gtin:${ref.gtin}` : `usda:${ref.fdcId}`);

/**
 * The external refs Dylan's live foods already hold: their barcodes and USDA ids. Archived
 * foods are left out, so their products can be found and imported again.
 */
export function libraryRefs(foods: readonly Food[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const food of foods) {
    if (food.archived) continue;
    for (const gtin of food.barcodes) refs.add(refKey({ kind: 'gtin', gtin }));
    if (food.source.kind === 'usda') refs.add(refKey({ kind: 'usda', fdcId: food.source.fdcId }));
  }
  return refs;
}

/** An online hit Dylan already has as a food, by its ref or any of its barcodes. */
export function inLibrary(hit: SearchHit, refs: ReadonlySet<string>): boolean {
  return refs.has(refKey(hit.ref)) || hit.candidate.barcodes.some((gtin) => refs.has(refKey({ kind: 'gtin', gtin })));
}

/** Recent then library foods and recipes matching the query, recents in use order. Instant and offline. */
export function searchLocal(input: {
  readonly query: string;
  readonly library: Library;
  readonly recents: readonly RecentFood[];
  readonly limit: number;
}): LocalHit[] {
  const hits = new Map<string, LocalHit>();
  for (const recent of input.recents) {
    if (matches(recent.food, input.query)) hits.set(recent.key, { key: recent.key, food: recent.food, lastQuantity: recent.lastQuantity });
  }
  for (const snapshot of offers(input.library)) {
    const key = foodKey(snapshot);
    if (!hits.has(key) && matches(snapshot, input.query)) hits.set(key, { key, food: snapshot, lastQuantity: undefined });
  }
  return [...hits.values()].slice(0, input.limit);
}
