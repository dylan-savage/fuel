/** Open Food Facts adapter. Raw JSON stays in this file; callers get FoodCandidate and SearchHit. */
import { z } from 'zod';
import type { FoodCandidate, Gtin, SearchHit, Serving } from '../domain/food.js';
import type { Millis } from '../domain/ids.js';
import { NUTRIENTS, type NutrientKey, type PartialNutrients } from '../domain/nutrients.js';
import type { FoodUnit } from '../domain/units.js';
import { amountOf, DEFAULT_TIMEOUT_MS, getJson, gtinOf, trimSlash, UpstreamError, type Answer, type Fetch } from './upstream.js';

/** What the parsers read. scripts/record-fixtures.mjs requests the same list. */
const FIELDS =
  'code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per';

const KJ_PER_KCAL = 4.184;
const SALT_PER_SODIUM = 2.5;

/**
 * Where each nutrient is read from in `nutriments`, with the factor into our unit. The first
 * known reading wins. OFF reports sodium and salt in grams, and `energy` in kJ.
 */
const READINGS: Readonly<Record<NutrientKey, readonly (readonly [field: string, factor: number])[]>> = {
  kcal: [
    ['energy-kcal', 1],
    ['energy-kj', 1 / KJ_PER_KCAL],
    ['energy', 1 / KJ_PER_KCAL],
  ],
  protein: [['proteins', 1]],
  carbs: [['carbohydrates', 1]],
  fat: [['fat', 1]],
  fiber: [['fiber', 1]],
  sugar: [['sugars', 1]],
  sodium: [
    ['sodium', 1000],
    ['salt', 1000 / SALT_PER_SODIUM],
  ],
};

const Text = z.string().trim().min(1).optional().catch(undefined);

const Product = z.looseObject({
  code: z.unknown().optional(),
  product_name: Text,
  generic_name: Text,
  /** A comma list in the product API, an array in search-a-licious. */
  brands: z.union([z.string().transform((s) => s.split(',')), z.array(z.unknown())]).catch([]),
  nutriments: z.record(z.string(), z.unknown()).catch({}),
  serving_size: Text,
  serving_quantity: z.unknown().optional(),
  serving_quantity_unit: Text,
  nutrition_data_per: Text,
});
type Product = z.infer<typeof Product>;

const ProductBody = z.looseObject({ status: z.unknown().optional(), product: Product.optional() });
const SearchBody = z.looseObject({ hits: z.array(z.unknown()) });

function nutrientsAt(nutriments: Readonly<Record<string, unknown>>, suffix: '_100g' | '_serving', scale: number): PartialNutrients {
  const out: PartialNutrients = {};
  for (const { key } of NUTRIENTS) {
    for (const [field, factor] of READINGS[key]) {
      const value = amountOf(nutriments[field + suffix]);
      if (value !== undefined) {
        out[key] = value * factor * scale;
        break;
      }
    }
  }
  return out;
}

/**
 * Per 100 g or ml as OFF reports it. Drinks report per 100 ml under the `_100g` keys. With only
 * per-serving values, a sized serving converts to per 100, and an unsized one becomes a portion.
 */
function basisOf(p: Product): { readonly unit: FoodUnit; readonly nutrients: PartialNutrients } {
  const unit = p.serving_quantity_unit?.toLowerCase() === 'ml' || p.nutrition_data_per?.toLowerCase() === '100ml' ? 'ml' : 'g';
  const per100 = nutrientsAt(p.nutriments, '_100g', 1);
  if (Object.keys(per100).length > 0) return { unit, nutrients: per100 };
  const perServing = nutrientsAt(p.nutriments, '_serving', 1);
  if (Object.keys(perServing).length === 0) return { unit, nutrients: {} };
  const size = amountOf(p.serving_quantity);
  if (size === undefined || size === 0) return { unit: 'portion', nutrients: perServing };
  return { unit, nutrients: nutrientsAt(p.nutriments, '_serving', 100 / size) };
}

function nameOf(p: Product): string | undefined {
  return p.product_name ?? p.generic_name;
}

function candidateOf(p: Product, name: string, gtin: Gtin, fetchedAt: Millis): FoodCandidate {
  const brand = p.brands.map((b) => (typeof b === 'string' ? b.trim() : '')).find((b) => b !== '');
  const { unit, nutrients } = basisOf(p);
  const size = amountOf(p.serving_quantity);
  const servings: Serving[] = size !== undefined && size > 0 ? [{ label: p.serving_size ?? '1 serving', amount: size }] : [];
  return {
    name,
    ...(brand === undefined ? {} : { brand }),
    unit,
    nutrients,
    servings,
    barcodes: [gtin],
    source: { kind: 'off', gtin, fetchedAt },
  };
}

/** A product API body as a candidate. Null when OFF says it has no such product (`status: 0`). */
export function parseOffProduct(body: unknown, gtin: Gtin, fetchedAt: Millis): FoodCandidate | null {
  const parsed = ProductBody.safeParse(body);
  if (!parsed.success) throw new UpstreamError('off: unreadable product response');
  if (parsed.data.status === 0) return null;
  const product = parsed.data.product;
  if (product === undefined) throw new UpstreamError('off: product response without a product');
  return candidateOf(product, nameOf(product) ?? `Product ${gtin}`, gtin, fetchedAt);
}

/** A search-a-licious body as hits, skipping any without a valid GTIN or a name. */
export function parseOffSearch(body: unknown, fetchedAt: Millis): SearchHit[] {
  const parsed = SearchBody.safeParse(body);
  if (!parsed.success) throw new UpstreamError('off: unreadable search response');
  return parsed.data.hits.flatMap((raw): SearchHit[] => {
    const product = Product.safeParse(raw);
    if (!product.success) return [];
    const gtin = gtinOf(product.data.code);
    const name = nameOf(product.data);
    if (gtin === null || name === undefined) return [];
    return [{ ref: { kind: 'gtin', gtin }, candidate: candidateOf(product.data, name, gtin, fetchedAt) }];
  });
}

export interface OffClient {
  /** The product API's raw answer, for the lookup cache to keep and parseOffProduct to read. */
  product(gtin: Gtin): Promise<Answer>;
  search(q: string, limit: number): Promise<SearchHit[]>;
}

export interface OffConfig {
  /** FUEL_OFF_URL, the product API. */
  readonly productUrl: string;
  /** FUEL_OFF_SEARCH_URL, search-a-licious. */
  readonly searchUrl: string;
  readonly userAgent: string;
  readonly fetch: Fetch;
  readonly now: () => Millis;
  readonly timeoutMs?: number;
}

export function createOffClient(cfg: OffConfig): OffClient {
  const get = (url: URL) =>
    getJson({
      source: 'off',
      fetch: cfg.fetch,
      url,
      headers: { 'User-Agent': cfg.userAgent },
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

  return {
    product: (gtin) => {
      const url = new URL(`${trimSlash(cfg.productUrl)}/api/v2/product/${gtin}.json`);
      url.searchParams.set('fields', FIELDS);
      return get(url);
    },
    search: async (q, limit) => {
      const url = new URL(`${trimSlash(cfg.searchUrl)}/search`);
      url.searchParams.set('q', q);
      url.searchParams.set('page_size', String(limit));
      url.searchParams.set('fields', FIELDS);
      return parseOffSearch((await get(url)).body, cfg.now());
    },
  };
}
