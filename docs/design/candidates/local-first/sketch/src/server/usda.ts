/** USDA FoodData Central adapter. Raw JSON stays in this file; callers get domain types. */
import { todo } from '../todo.js';
import type { FoodCandidate, SearchHit } from '../domain/food.js';

export interface UsdaClient {
  /** GET /fdc/v1/foods/search?query=&dataType=Foundation,SR%20Legacy,Branded&pageSize=&api_key= */
  search(q: string, limit: number): Promise<unknown>;
  /** GET /fdc/v1/food/{fdcId}?api_key=. Null on 404. */
  food(fdcId: number): Promise<unknown | null>;
}

export function createUsdaClient(cfg: { apiKey: string; fetch?: typeof fetch }): UsdaClient {
  return todo(`createUsdaClient(${cfg.apiKey.length})`);
}

/**
 * Pure. Values are per 100 g. Nutrient mapping by FDC nutrient number, to be verified
 * against recorded responses: 208 energy kcal (fallback 957/958 Atwater energy), 203 protein,
 * 204 fat, 205 carbs, 291 fiber, 269 total sugars, 307 sodium (mg).
 * Search hits carry complete: false because search results omit portions.
 */
export function parseUsdaSearch(raw: unknown): SearchHit[] {
  return todo(`parseUsdaSearch(${typeof raw})`);
}

/** Pure. Detail response to a candidate; foodPortions with gramWeight become servings. */
export function parseUsdaFood(raw: unknown): FoodCandidate | null {
  return todo(`parseUsdaFood(${typeof raw})`);
}
