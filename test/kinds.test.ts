import { describe, expect, it } from 'vitest';
import { WorkoutId } from '../src/domain/ids.js';
import { DB_VERSION, SCHEMA_HISTORY, dexieStores, parseDoc } from '../src/domain/kinds.js';
import { weighIn, workout } from './fixtures.js';

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

describe('body documents', () => {
  it('give a weigh-in one id per day, so logging twice on a day rewrites one document', () => {
    expect(parseDoc('weighIn', weighIn('2026-10-28', 80)).ok).toBe(true);
    expect(parseDoc('weighIn', { ...weighIn('2026-10-28', 80), id: 'w:2026-10-27' }).ok).toBe(false);
  });

  it('accept a workout from an activity this app does not list', () => {
    const run = workout(WorkoutId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c'), 80);
    expect(parseDoc('workout', { ...run, name: 'Padel', source: { kind: 'met', activity: 'padel', met: 6 } }).ok).toBe(true);
    expect(parseDoc('workout', { ...run, source: { kind: 'met', activity: 'run_6', met: 0.5 } }).ok).toBe(false);
  });
});

describe('documents from a newer app', () => {
  it('keep fields this app does not know, at every depth, so rewriting one drops nothing', () => {
    const newer = {
      id: '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c',
      date: '2026-10-28',
      meal: 'lunch',
      loggedAt: 1,
      photoId: 'p-1',
      food: {
        name: 'Soup',
        unit: 'g',
        nutrients: { kcal: 40, saturatedFat: 0.4 },
        servings: [{ label: '1 cup', amount: 249, household: 'cup' }],
        origin: { kind: 'adhoc', via: 'voice' },
        imageUrl: 'https://example.invalid/soup.jpg',
      },
      quantity: { kind: 'serving', serving: { label: '1 cup', amount: 249, household: 'cup' }, count: 1, note: 'about' },
    };
    expect(parseDoc('entry', newer)).toEqual({ ok: true, doc: newer });
  });
});
