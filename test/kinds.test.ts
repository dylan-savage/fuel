import { describe, expect, it } from 'vitest';
import { DB_VERSION, SCHEMA_HISTORY, dexieStores, parseDoc } from '../src/domain/kinds.js';

describe('schema history', () => {
  it('pins the derived IndexedDB layout: append dexieStores() to SCHEMA_HISTORY when this fails', () => {
    expect(dexieStores()).toEqual(SCHEMA_HISTORY.at(-1));
  });

  it('derives the database version from the history length', () => {
    expect(DB_VERSION).toBe(SCHEMA_HISTORY.length);
  });
});

describe('parseDoc', () => {
  it('rejects an entry whose food snapshot has no kcal', () => {
    const entry = {
      id: '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c',
      date: '2026-10-28',
      meal: 'lunch',
      loggedAt: 1,
      food: { name: 'Soup', unit: 'portion', nutrients: { protein: 3 }, servings: [], origin: { kind: 'adhoc' } },
      quantity: { kind: 'amount', amount: 1 },
    };
    expect(parseDoc('entry', entry).ok).toBe(false);
    expect(parseDoc('entry', { ...entry, food: { ...entry.food, nutrients: { kcal: 120 } } }).ok).toBe(true);
  });

  it('rejects a library food missing a core macro', () => {
    const food = {
      id: '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c',
      name: 'Oats',
      unit: 'g',
      nutrients: { kcal: 380, protein: 13, carbs: 67 },
      servings: [],
      barcodes: [],
      source: { kind: 'user' },
      archived: false,
    };
    expect(parseDoc('food', food).ok).toBe(false);
    expect(parseDoc('food', { ...food, nutrients: { ...food.nutrients, fat: 7 } }).ok).toBe(true);
  });
});
