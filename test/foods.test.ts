import { afterEach, describe, expect, it } from 'vitest';
import { Gtin, type ExternalRef, type SearchHit } from '../src/domain/food.js';
import { createFoodSources } from '../src/server/foods.js';
import { parseOffSearch, type OffClient } from '../src/server/off.js';
import { openStore, type DocStore } from '../src/server/store.js';
import { UpstreamError, type Answer } from '../src/server/upstream.js';
import { parseUsdaSearch, type UsdaClient, type UsdaHits } from '../src/server/usda.js';
import { at } from './fixtures.js';
import { answerOf, recording } from './recordings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const coke: ExternalRef = { kind: 'gtin', gtin: Gtin.parse('0049000000443') };
const unknown: ExternalRef = { kind: 'gtin', gtin: Gtin.parse('0028400999991') };
const RECORDED: Readonly<Record<string, string>> = { '0049000000443': 'coca-cola', '0028400999991': 'unknown' };

const recordedProduct = (gtin: Gtin): Promise<Answer> => {
  const name = RECORDED[gtin];
  return name === undefined ? Promise.reject(new Error(`no recording for ${gtin}`)) : Promise.resolve(answerOf(recording('off', name)));
};
const offHits = () => parseOffSearch(recording('off', 'search-greek-yogurt').body, at(1));
const failing = () => Promise.reject(new UpstreamError('down'));

const usdaHit = (fdcId: number, name: string, barcodes: Gtin[] = []): SearchHit => ({
  ref: { kind: 'usda', fdcId },
  candidate: { name, unit: 'g', nutrients: {}, servings: [], barcodes, source: { kind: 'usda', fdcId } },
});
const usdaClient = (client: Partial<UsdaClient>): UsdaClient => ({
  search: () => Promise.reject(new Error('search not stubbed')),
  food: () => Promise.reject(new Error('food not stubbed')),
  ...client,
});

const stores: DocStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** FoodSources over a real in-memory cache, a clock the test moves, and sources that count calls. */
function setup(
  opts: {
    readonly product?: (gtin: Gtin) => Promise<Answer>;
    readonly offSearch?: OffClient['search'];
    readonly usda?: UsdaClient | null;
  } = {},
) {
  const store = openStore(':memory:');
  stores.push(store);
  let clock = 1_800_000_000_000;
  const calls = { off: 0 };
  const off: OffClient = {
    product: (gtin) => {
      calls.off += 1;
      return (opts.product ?? recordedProduct)(gtin);
    },
    search: opts.offSearch ?? (() => Promise.resolve(offHits())),
  };
  const foods = createFoodSources({ off, usda: opts.usda ?? null, cache: store.lookupCache, now: () => at(clock) });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { foods, calls, advance };
}

describe('FoodSources.lookup', () => {
  it('answers a repeat lookup from the cache without asking Open Food Facts again', async () => {
    const { foods, calls } = setup();
    const first = await foods.lookup(coke);
    expect(first).toMatchObject({ kind: 'found', candidate: { name: 'Coca-Cola', unit: 'ml' } });
    expect(await foods.lookup(coke)).toEqual(first);
    expect(calls.off).toBe(1);
  });

  it('asks again once a found product is 30 days old', async () => {
    const { foods, calls, advance } = setup();
    await foods.lookup(coke);
    advance(30 * DAY_MS - 1);
    await foods.lookup(coke);
    expect(calls.off).toBe(1);
    advance(1);
    await foods.lookup(coke);
    expect(calls.off).toBe(2);
  });

  it('remembers not_found for a day', async () => {
    const { foods, calls, advance } = setup();
    expect(await foods.lookup(unknown)).toEqual({ kind: 'not_found' });
    advance(DAY_MS - 1);
    expect(await foods.lookup(unknown)).toEqual({ kind: 'not_found' });
    expect(calls.off).toBe(1);
    advance(1);
    await foods.lookup(unknown);
    expect(calls.off).toBe(2);
  });

  it('surfaces a failure as an UpstreamError and does not cache it', async () => {
    let attempts = 0;
    const { foods } = setup({ product: (gtin) => (++attempts === 1 ? failing() : recordedProduct(gtin)) });
    await expect(foods.lookup(coke)).rejects.toBeInstanceOf(UpstreamError);
    expect(await foods.lookup(coke)).toMatchObject({ kind: 'found' });
  });

  it('answers a usda ref with an UpstreamError when USDA is not configured', async () => {
    const { foods } = setup({ usda: null });
    await expect(foods.lookup({ kind: 'usda', fdcId: 173944 })).rejects.toBeInstanceOf(UpstreamError);
  });

  it('asks USDA for a usda ref and caches its not_found', async () => {
    let asked = 0;
    const usda = usdaClient({
      food: () => {
        asked += 1;
        return Promise.resolve({ status: 404, body: null });
      },
    });
    const { foods, calls } = setup({ usda });
    expect(await foods.lookup({ kind: 'usda', fdcId: 1 })).toEqual({ kind: 'not_found' });
    expect(await foods.lookup({ kind: 'usda', fdcId: 1 })).toEqual({ kind: 'not_found' });
    expect({ asked, off: calls.off }).toEqual({ asked: 1, off: 0 });
  });
});

describe('FoodSources.search', () => {
  const chobani = Gtin.parse('0894700010137');
  const usdaHits: UsdaHits = {
    generic: [usdaHit(1, 'Yogurt, Greek, plain, nonfat')],
    branded: [usdaHit(2, 'NONFAT GREEK YOGURT', [chobani])],
  };
  const usda = usdaClient({ search: () => Promise.resolve(usdaHits) });

  it('searches Open Food Facts alone when USDA is not configured', async () => {
    const { foods } = setup({ usda: null });
    expect(await foods.search('greek yogurt', 20)).toEqual(offHits());
  });

  it('ranks USDA generic foods first, then branded products, one hit per GTIN', async () => {
    const { foods } = setup({ usda });
    const hits = await foods.search('greek yogurt', 20);
    expect(hits.slice(0, 2)).toEqual([...usdaHits.generic, ...usdaHits.branded]);
    expect(hits.slice(2)).toEqual(offHits().filter((h) => !h.candidate.barcodes.includes(chobani)));
    expect(hits.filter((h) => h.candidate.barcodes.includes(chobani))).toHaveLength(1);
  });

  it('ranks real USDA whole foods by how well their names match', async () => {
    const banana = parseUsdaSearch(recording('usda', 'search-banana').body);
    const { foods } = setup({ usda: usdaClient({ search: () => Promise.resolve(banana) }), offSearch: () => Promise.resolve([]) });
    const names = (await foods.search('banana', 20)).map((h) => h.candidate.name);
    expect(names[0]).toBe('Bananas, raw');
    expect(names.indexOf('Bananas, raw')).toBeLessThan(names.indexOf('Bananas, dehydrated, or banana powder'));
  });

  it("returns USDA's hits when Open Food Facts fails", async () => {
    const { foods } = setup({ usda, offSearch: failing });
    expect(await foods.search('greek yogurt', 20)).toEqual([...usdaHits.generic, ...usdaHits.branded]);
  });

  it("returns Open Food Facts' hits when USDA fails", async () => {
    const { foods } = setup({ usda: usdaClient({ search: failing }) });
    expect(await foods.search('greek yogurt', 20)).toEqual(offHits());
  });

  it.each([
    ['USDA is not configured and Open Food Facts fails', null],
    ['both sources fail', usdaClient({ search: failing })],
  ])('throws an UpstreamError when %s', async (_, usdaSource) => {
    const { foods } = setup({ usda: usdaSource, offSearch: failing });
    await expect(foods.search('greek yogurt', 20)).rejects.toBeInstanceOf(UpstreamError);
  });
});
