import { describe, expect, it } from 'vitest';
import {
  completeFood,
  nutrientsFor,
  parseGtin,
  quickAddItem,
  type FoodCandidate,
  type FoodSnapshot,
} from '../src/domain/food.js';
import { FoodId } from '../src/domain/ids.js';
import { total } from '../src/domain/nutrients.js';

const bread: FoodSnapshot = {
  name: 'Sourdough',
  unit: 'g',
  nutrients: { kcal: 250, protein: 10, carbs: 48, fat: 1.5 },
  servings: [{ label: '1 slice', amount: 30 }],
  origin: { kind: 'adhoc' },
};

describe('nutrientsFor', () => {
  it('scales per-100 g nutrients by an amount in grams', () => {
    const n = nutrientsFor(bread, { kind: 'amount', amount: 40 });
    expect(n.kcal).toBeCloseTo(100);
    expect(n.protein).toBeCloseTo(4);
    expect(n.carbs).toBeCloseTo(19.2);
    expect(n.fat).toBeCloseTo(0.6);
  });

  it('resolves a serving quantity from the copied serving', () => {
    const twoSlices = nutrientsFor(bread, { kind: 'serving', serving: { label: '1 slice', amount: 30 }, count: 2 });
    expect(twoSlices.kcal).toBe(150);
  });

  it('scales portion foods per one portion', () => {
    const burrito: FoodSnapshot = { ...bread, unit: 'portion', nutrients: { kcal: 900 } };
    expect(nutrientsFor(burrito, { kind: 'amount', amount: 1.5 })).toEqual({ kcal: 1350 });
  });

  it('keeps unknown nutrients unknown instead of zero', () => {
    expect(nutrientsFor(bread, { kind: 'amount', amount: 100 })).not.toHaveProperty('fiber');
  });
});

describe('total', () => {
  it('marks a nutrient incomplete when any item lacks it, summing what is known', () => {
    const t = total([nutrientsFor(bread, { kind: 'amount', amount: 100 }), quickAddItem('Dinner out', { kcal: 800 }).food.nutrients]);
    expect(t.sum.kcal).toBe(1050);
    expect(t.sum.protein).toBe(10);
    expect([...t.incomplete].sort()).toEqual(['carbs', 'fat', 'fiber', 'protein', 'sodium', 'sugar']);
  });

  it('is complete for a nutrient every item reports', () => {
    expect(total([{ kcal: 1, fiber: 2 }, { kcal: 3, fiber: 0 }]).incomplete.has('fiber')).toBe(false);
  });
});

describe('completeFood', () => {
  const id = FoodId.parse('6f1c2d1e-4b8a-4c1e-9f0a-1d2e3f4a5b6c');
  const candidate: FoodCandidate = {
    name: 'Greek yogurt',
    unit: 'g',
    nutrients: { kcal: 97, carbs: 3.6 },
    servings: [],
    barcodes: [],
    source: { kind: 'user' },
  };

  it('names the core nutrients the candidate is missing', () => {
    expect(completeFood(candidate, id)).toEqual({ ok: false, missing: ['protein', 'fat'] });
  });

  it('returns a library food once every core nutrient is known', () => {
    const result = completeFood({ ...candidate, nutrients: { ...candidate.nutrients, protein: 9, fat: 5 } }, id);
    expect(result).toEqual({
      ok: true,
      food: { ...candidate, id, nutrients: { kcal: 97, carbs: 3.6, protein: 9, fat: 5 }, archived: false },
    });
  });
});

describe('parseGtin', () => {
  it('pads UPC-A to 13 digits', () => {
    expect(parseGtin('upc_a', '049000000443')).toBe('0049000000443');
  });

  it('keeps a valid EAN-13', () => {
    expect(parseGtin('ean_13', '4006381333931')).toBe('4006381333931');
  });

  it('pads EAN-8 to 13 digits', () => {
    expect(parseGtin('ean_8', '96385074')).toBe('0000096385074');
  });

  it('expands UPC-E to its UPC-A number', () => {
    expect(parseGtin('upc_e', '01234565')).toBe('0012345000065');
  });

  it('rejects a wrong check digit', () => {
    expect(parseGtin('ean_13', '4006381333932')).toBeNull();
  });

  it('accepts the 13-digit forms zxing reports for UPC-A and UPC-E', () => {
    expect(parseGtin('ean_13', '0049000000443')).toBe('0049000000443');
    expect(parseGtin('upc_e', '0012345000065')).toBe('0012345000065');
  });

  it('rejects non-digits, impossible lengths and non-retail formats', () => {
    expect(parseGtin('upc_a', 'abcdefghijkl')).toBeNull();
    expect(parseGtin('ean_13', '12345')).toBeNull();
    expect(parseGtin('qr_code', '4006381333931')).toBeNull();
  });
});
