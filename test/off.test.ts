import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Gtin } from '../src/domain/food.js';
import { parseOffProduct, parseOffSearch } from '../src/server/off.js';
import { UpstreamError } from '../src/server/upstream.js';
import { at } from './fixtures.js';
import { recording } from './recordings.js';

const fetchedAt = at(1_800_000_000_000);
const gtin = (digits: string) => Gtin.parse(digits);

const product = (name: string, digits: string) => parseOffProduct(recording('off', name).body, gtin(digits), fetchedAt);
const lays = (body: unknown) => parseOffProduct(body, gtin('0028400090858'), fetchedAt);

/** The Lay's recording with its product edited, for rules today's recordings do not exercise. */
function editedLays(edit: (product: Record<string, unknown>, nutriments: Record<string, unknown>) => void): unknown {
  const body = z
    .looseObject({ product: z.looseObject({ nutriments: z.record(z.string(), z.unknown()) }) })
    .parse(structuredClone(recording('off', 'lays').body));
  edit(body.product, body.product.nutriments);
  return body;
}

const dropKeys = (record: Record<string, unknown>, test: (key: string) => boolean) => {
  for (const key of Object.keys(record)) if (test(key)) delete record[key];
};

describe('parseOffProduct', () => {
  it('reads a drink per 100 ml with the bottle as its serving', () => {
    const coke = product('coca-cola', '0049000000443');
    expect(coke).toMatchObject({
      name: 'Coca-Cola',
      brand: 'Coca-Cola',
      unit: 'ml',
      servings: [{ label: '591 ml', amount: 591 }],
      barcodes: ['0049000000443'],
      source: { kind: 'off', gtin: '0049000000443', fetchedAt },
    });
    expect(coke?.nutrients.kcal).toBeCloseTo(42.3);
    expect(coke?.nutrients.sugar).toBeCloseTo(10.66);
    expect(coke?.nutrients.fat).toBe(0);
  });

  it('converts sodium from grams to milligrams', () => {
    expect(product('lays', '0028400090858')?.nutrients.sodium).toBeCloseTo(494.7);
  });

  it('keeps a serving measured in grams', () => {
    expect(product('lays', '0028400090858')).toMatchObject({
      brand: "Lay's",
      unit: 'g',
      servings: [{ label: '1 portion (28.3 g)', amount: 28.3 }],
    });
  });

  it('has no servings when the product lists none, and takes the first of several brands', () => {
    const nutella = product('nutella', '3017620422003');
    expect(nutella).toMatchObject({ name: 'Nutella', brand: 'Nutella', unit: 'g', servings: [] });
    expect(nutella?.nutrients.kcal).toBe(539);
  });

  it('measures in ml when the serving quantity is in ml, even with grams in the label', () => {
    expect(product('progresso', '0041196910759')).toMatchObject({
      unit: 'ml',
      servings: [{ label: '1 cup (249 g)', amount: 249 }],
    });
  });

  it('omits an empty brand', () => {
    const pecorino = product('pecorino', '2000000000008');
    expect(pecorino?.name).toBe('Pecorino biologico');
    expect(pecorino).not.toHaveProperty('brand');
  });

  it('is null when OFF does not know the product', () => {
    expect(product('unknown', '0028400999991')).toBeNull();
  });

  it('throws an UpstreamError on a body that is not a product response', () => {
    expect(() => lays(null)).toThrow(UpstreamError);
    expect(() => lays({ status: 1 })).toThrow(UpstreamError);
  });

  it('names a product by its generic name, then by its GTIN', () => {
    expect(lays(editedLays((p) => delete p.product_name))?.name).toBe('Potato chips');
    expect(
      lays(
        editedLays((p) => {
          delete p.product_name;
          p.generic_name = '';
        }),
      )?.name,
    ).toContain('0028400090858');
  });

  it('falls back from kcal to kJ, and to energy in kJ', () => {
    const kj = lays(editedLays((_, n) => dropKeys(n, (k) => k.startsWith('energy-kcal'))));
    expect(kj?.nutrients.kcal).toBeCloseTo(2356.89 / 4.184);
    const energy = lays(editedLays((_, n) => dropKeys(n, (k) => k.startsWith('energy-'))));
    expect(energy?.nutrients.kcal).toBeCloseTo(2356.89 / 4.184);
  });

  it('derives sodium from salt when sodium is absent', () => {
    const fromSalt = lays(editedLays((_, n) => dropKeys(n, (k) => k.startsWith('sodium'))));
    expect(fromSalt?.nutrients.sodium).toBeCloseTo((1.2367 / 2.5) * 1000, 0);
  });

  it('reads numeric strings and treats negative or non-numeric values as unknown', () => {
    const odd = lays(
      editedLays((p, n) => {
        p.serving_quantity = '28.3';
        n.proteins_100g = '7.5';
        n.fat_100g = -1;
        n.fiber_100g = 'traces';
      }),
    );
    expect(odd?.nutrients.protein).toBe(7.5);
    expect(odd?.nutrients).not.toHaveProperty('fat');
    expect(odd?.nutrients).not.toHaveProperty('fiber');
    expect(odd?.servings).toEqual([{ label: '1 portion (28.3 g)', amount: 28.3 }]);
  });

  it('converts per-serving values to per 100 g when the serving has a size', () => {
    const perServing = lays(editedLays((_, n) => dropKeys(n, (k) => k.endsWith('_100g'))));
    expect(perServing?.unit).toBe('g');
    expect(perServing?.nutrients.kcal).toBeCloseTo((160 / 28.3) * 100);
    expect(perServing?.nutrients.sodium).toBeCloseTo((0.14 / 28.3) * 100 * 1000);
  });

  it('keeps per-serving values as one portion when the serving has no size', () => {
    const portion = lays(
      editedLays((p, n) => {
        dropKeys(n, (k) => k.endsWith('_100g'));
        delete p.serving_quantity;
      }),
    );
    expect(portion).toMatchObject({ unit: 'portion', servings: [] });
    expect(portion?.nutrients.kcal).toBe(160);
  });
});

describe('parseOffSearch', () => {
  const hits = () => parseOffSearch(recording('off', 'search-greek-yogurt').body, fetchedAt);

  it('normalizes every hit to a 13-digit GTIN ref, padding EAN-8 codes', () => {
    const found = hits();
    expect(found).toHaveLength(20);
    for (const { ref, candidate } of found) {
      expect(ref.kind).toBe('gtin');
      expect(candidate.barcodes).toEqual([ref.kind === 'gtin' ? ref.gtin : null]);
    }
    expect(found.map((h) => h.candidate.barcodes[0])).toContain('0000020577414');
  });

  it('takes the brand from the search array', () => {
    expect(hits()[0]?.candidate).toMatchObject({ name: 'Nonfat Greek Yogurt', brand: 'Chobani' });
  });

  it('derives kcal from kJ when the index has only kJ', () => {
    const mandarin = hits().find((h) => h.candidate.barcodes[0] === '9310653103173');
    expect(mandarin?.candidate.nutrients.kcal).toBeCloseTo(395 / 4.184);
  });

  it('skips hits without a valid GTIN or a name', () => {
    const body = z.looseObject({ hits: z.array(z.unknown()) }).parse(structuredClone(recording('off', 'search-greek-yogurt').body));
    body.hits.push({ code: '0894700010138', product_name: 'Bad check digit' }, { code: 'abc', product_name: 'Not a code' }, { code: '0028400090858' });
    expect(parseOffSearch(body, fetchedAt)).toHaveLength(20);
  });

  it('throws an UpstreamError on a body that is not a search response', () => {
    expect(() => parseOffSearch({ detail: 'Not Found' }, fetchedAt)).toThrow(UpstreamError);
  });
});
