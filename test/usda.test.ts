import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createUsdaClient, parseUsdaFood, parseUsdaSearch } from '../src/server/usda.js';
import { UpstreamError, type Fetch } from '../src/server/upstream.js';
import { recording, replay } from './recordings.js';

const search = recording('usda', 'search-banana');
const generic = recording('usda', 'food-generic');
const branded = recording('usda', 'food-branded');

const client = (fetch: Fetch) =>
  createUsdaClient({ baseUrl: 'https://api.nal.usda.gov/fdc/', apiKey: 'test-key', userAgent: 'fuel/test', fetch });

describe('parseUsdaSearch', () => {
  it('splits whole foods from branded products', () => {
    const hits = parseUsdaSearch(search.body);
    expect(hits.generic).toHaveLength(18);
    expect(hits.branded).toHaveLength(2);
    expect(hits.generic.map((h) => h.candidate.name)).toContain('Bananas, raw');
  });

  it('reads per-100 g nutrients from search rows', () => {
    const raw = parseUsdaSearch(search.body).generic.find((h) => h.candidate.name === 'Bananas, raw');
    expect(raw).toMatchObject({
      ref: { kind: 'usda', fdcId: 173944 },
      candidate: {
        unit: 'g',
        nutrients: { kcal: 89, protein: 1.09, carbs: 22.8, fat: 0.33, fiber: 2.6, sugar: 12.2, sodium: 1 },
        source: { kind: 'usda', fdcId: 173944 },
      },
    });
  });

  it('refuses a body that is not a search response', () => {
    expect(() => parseUsdaSearch({ error: 'nope' })).toThrow(UpstreamError);
  });
});

describe('parseUsdaFood', () => {
  it('reads a whole food with its gram portions and no brand', () => {
    const food = parseUsdaFood(generic.body);
    expect(food).toMatchObject({
      name: 'Bananas, dehydrated, or banana powder',
      unit: 'g',
      nutrients: { kcal: 346, protein: 3.89, carbs: 88.28, fat: 1.81, fiber: 9.9, sugar: 47.3, sodium: 3 },
      servings: [
        { label: '1 tbsp', amount: 6.2 },
        { label: '1 cup', amount: 100 },
      ],
      barcodes: [],
    });
    expect(food).not.toHaveProperty('brand');
  });

  it('leaves kcal unknown rather than reading the kJ row', () => {
    const Row = z.looseObject({ nutrient: z.looseObject({ number: z.string() }).optional() });
    const body = z.looseObject({ foodNutrients: z.array(Row) }).parse(structuredClone(generic.body));
    body.foodNutrients = body.foodNutrients.filter((row) => row.nutrient?.number !== '208');
    const food = parseUsdaFood(body);
    expect(food?.nutrients.kcal).toBeUndefined();
    expect(food?.nutrients.protein).toBe(3.89);
  });

  it('reads a branded product with its label serving and barcode', () => {
    expect(parseUsdaFood(branded.body)).toMatchObject({
      name: 'BANANA',
      brand: "BETTER'N PEANUT BUTTER",
      unit: 'g',
      nutrients: { kcal: 312, protein: 12.5, carbs: 40.62, fat: 6.25, fiber: 6.2, sugar: 6.25, sodium: 594 },
      servings: [{ label: '2 Tbsp', amount: 32 }],
      barcodes: ['0016459200441'],
    });
  });

  it('is null when USDA has no such food', () => {
    expect(parseUsdaFood(null)).toBeNull();
  });
});

describe('createUsdaClient', () => {
  it('sends the key only as a header, never in the URL', async () => {
    const { fetch, sent } = replay(search);
    const hits = await client(fetch).search('banana', 20);
    expect(hits.generic.length + hits.branded.length).toBe(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).not.toContain('test-key');
    expect(sent[0]?.headers).toMatchObject({ 'X-Api-Key': 'test-key', 'User-Agent': 'fuel/test' });
  });

  it('fetches a food by id', async () => {
    const { fetch } = replay(generic);
    const answer = await client(fetch).food(173945);
    expect(parseUsdaFood(answer.body)?.name).toBe('Bananas, dehydrated, or banana powder');
  });

  it('answers a missing food with a null body', async () => {
    const notFound: Fetch = () => Promise.resolve(new Response('{"error":"Not Found"}', { status: 404 }));
    expect(await client(notFound).food(1)).toEqual({ status: 404, body: null });
  });
});
