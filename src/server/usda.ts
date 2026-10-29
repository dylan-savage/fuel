/** USDA FoodData Central adapter. Raw JSON stays in this file; callers get FoodCandidate and SearchHit. */
import { z } from 'zod';
import { FdcId, type FoodCandidate, type SearchHit, type Serving } from '../domain/food.js';
import { NUTRIENTS, type NutrientKey, type PartialNutrients } from '../domain/nutrients.js';
import type { FoodUnit } from '../domain/units.js';
import { amountOf, DEFAULT_TIMEOUT_MS, getJson, gtinOf, trimSlash, UpstreamError, type Answer, type Fetch } from './upstream.js';

const DATA_TYPES = 'Foundation,SR Legacy,Branded';
const GENERIC_TYPES: ReadonlySet<string> = new Set(['Foundation', 'SR Legacy']);
const ML_UNITS: ReadonlySet<string> = new Set(['ml', 'mlt']);
const G_UNITS: ReadonlySet<string> = new Set(['g', 'grm']);

/**
 * FDC nutrient numbers, first known wins. Values are per 100 g, or per 100 ml for a branded
 * food served in ml. Energy falls back to the Atwater rows, never to the kJ row (268).
 */
const NUMBERS: Readonly<Record<NutrientKey, readonly string[]>> = {
  kcal: ['208', '958', '957'],
  protein: ['203'],
  carbs: ['205'],
  fat: ['204'],
  fiber: ['291'],
  sugar: ['269'],
  sodium: ['307'],
};

const Text = z.string().trim().min(1).optional().catch(undefined);

/** Search rows carry `nutrientNumber` and `value`; detail rows nest the number and call it `amount`. */
const NutrientRow = z.union([
  z.looseObject({ nutrientNumber: z.string(), value: z.unknown().optional() }).transform((r): [string, unknown] => [r.nutrientNumber, r.value]),
  z
    .looseObject({ nutrient: z.looseObject({ number: z.string() }), amount: z.unknown().optional() })
    .transform((r): [string, unknown] => [r.nutrient.number, r.amount]),
]);

const Portion = z.looseObject({
  gramWeight: z.unknown().optional(),
  amount: z.unknown().optional(),
  modifier: Text,
  portionDescription: Text,
  measureUnit: z.looseObject({ name: Text }).optional().catch(undefined),
});
type Portion = z.infer<typeof Portion>;

const Food = z.looseObject({
  fdcId: FdcId,
  description: Text,
  dataType: Text,
  brandName: Text,
  brandOwner: Text,
  gtinUpc: z.unknown().optional(),
  servingSize: z.unknown().optional(),
  servingSizeUnit: Text,
  householdServingFullText: Text,
  foodNutrients: z.array(z.unknown()).catch([]),
  foodPortions: z.array(z.unknown()).catch([]),
});
type Food = z.infer<typeof Food>;

const SearchBody = z.looseObject({ foods: z.array(z.unknown()) });

function nutrientsOf(rows: readonly unknown[]): PartialNutrients {
  const byNumber = new Map<string, number>();
  for (const row of rows) {
    const parsed = NutrientRow.safeParse(row);
    const value = parsed.success ? amountOf(parsed.data[1]) : undefined;
    if (parsed.success && value !== undefined) byNumber.set(parsed.data[0], value);
  }
  const out: PartialNutrients = {};
  for (const { key } of NUTRIENTS) {
    const value = NUMBERS[key].map((n) => byNumber.get(n)).find((v) => v !== undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function portionLabel(p: Portion): string {
  if (p.portionDescription !== undefined) return p.portionDescription;
  const measure = p.measureUnit?.name === 'undetermined' ? undefined : p.measureUnit?.name;
  return [String(amountOf(p.amount) ?? 1), measure, p.modifier].filter((part) => part !== undefined).join(' ');
}

function portionServing(raw: unknown): Serving[] {
  const portion = Portion.safeParse(raw);
  const grams = portion.success ? amountOf(portion.data.gramWeight) : undefined;
  return portion.success && grams !== undefined && grams > 0 ? [{ label: portionLabel(portion.data), amount: grams }] : [];
}

/** The branded label serving when it is in the food's unit, then gram portions for foods in grams. */
function servingsOf(food: Food, unit: FoodUnit): Serving[] {
  const size = amountOf(food.servingSize);
  const sizeUnit = food.servingSizeUnit?.toLowerCase() ?? '';
  const inUnit = (unit === 'ml' ? ML_UNITS : G_UNITS).has(sizeUnit);
  const label: Serving[] =
    size !== undefined && size > 0 && inUnit ? [{ label: food.householdServingFullText ?? `${size} ${unit}`, amount: size }] : [];
  return [...label, ...(unit === 'g' ? food.foodPortions.flatMap(portionServing) : [])];
}

function candidateOf(food: Food, name: string): FoodCandidate {
  const unit: FoodUnit = ML_UNITS.has(food.servingSizeUnit?.toLowerCase() ?? '') ? 'ml' : 'g';
  const brand = food.brandName ?? food.brandOwner;
  const gtin = gtinOf(food.gtinUpc);
  return {
    name,
    ...(brand === undefined ? {} : { brand }),
    unit,
    nutrients: nutrientsOf(food.foodNutrients),
    servings: servingsOf(food, unit),
    barcodes: gtin === null ? [] : [gtin],
    source: { kind: 'usda', fdcId: food.fdcId },
  };
}

/** Search hits split by tier, because generic foods rank above branded products. */
export interface UsdaHits {
  /** Foundation and SR Legacy: whole foods with no brand. */
  readonly generic: SearchHit[];
  readonly branded: SearchHit[];
}

/** A foods/search body as hits, skipping any without an id or a description. */
export function parseUsdaSearch(body: unknown): UsdaHits {
  const parsed = SearchBody.safeParse(body);
  if (!parsed.success) throw new UpstreamError('usda: unreadable search response');
  const hits: UsdaHits = { generic: [], branded: [] };
  for (const raw of parsed.data.foods) {
    const food = Food.safeParse(raw);
    if (!food.success || food.data.description === undefined) continue;
    const tier = GENERIC_TYPES.has(food.data.dataType ?? '') ? hits.generic : hits.branded;
    tier.push({ ref: { kind: 'usda', fdcId: food.data.fdcId }, candidate: candidateOf(food.data, food.data.description) });
  }
  return hits;
}

/** A food detail body as a candidate. Null when USDA has no such food (the client's 404). */
export function parseUsdaFood(body: unknown): FoodCandidate | null {
  if (body === null) return null;
  const food = Food.safeParse(body);
  if (!food.success) throw new UpstreamError('usda: unreadable food response');
  return candidateOf(food.data, food.data.description ?? `USDA food ${food.data.fdcId}`);
}

export interface UsdaClient {
  search(q: string, limit: number): Promise<UsdaHits>;
  /** The food detail's raw answer, for the lookup cache. A 404 answers with a null body. */
  food(fdcId: number): Promise<Answer>;
}

export interface UsdaConfig {
  /** FUEL_USDA_URL. */
  readonly baseUrl: string;
  /** Sent only as the X-Api-Key header, so it never appears in a URL or a log line. */
  readonly apiKey: string;
  readonly userAgent: string;
  readonly fetch: Fetch;
  readonly timeoutMs?: number;
}

export function createUsdaClient(cfg: UsdaConfig): UsdaClient {
  const base = trimSlash(cfg.baseUrl);
  const get = (url: URL) =>
    getJson({
      source: 'usda',
      fetch: cfg.fetch,
      url,
      headers: { 'User-Agent': cfg.userAgent, 'X-Api-Key': cfg.apiKey },
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

  return {
    search: async (q, limit) => {
      const url = new URL(`${base}/v1/foods/search`);
      url.searchParams.set('query', q);
      url.searchParams.set('pageSize', String(limit));
      url.searchParams.set('dataType', DATA_TYPES);
      return parseUsdaSearch((await get(url)).body);
    },
    food: async (fdcId) => {
      const answer = await get(new URL(`${base}/v1/food/${fdcId}`));
      return answer.status === 404 ? { status: 404, body: null } : answer;
    },
  };
}
