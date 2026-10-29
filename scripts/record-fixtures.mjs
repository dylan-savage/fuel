// Records real Open Food Facts and USDA FoodData Central responses into test/fixtures/<source>/
// so the adapter tests run against what the services really send, with no network.
//
//   node --env-file-if-exists=../.env.local scripts/record-fixtures.mjs [off] [usda]
//
// The route tests replay these by exact request URL, so every URL here must be built the way
// src/server/off.ts and src/server/usda.ts build theirs. USDA_API_KEY is read from the
// environment, sent only as the X-Api-Key header, and never written to a fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const userAgent = `fuel/${version} (single-user calorie tracker)`;

const OFF_URL = 'https://world.openfoodfacts.org';
const OFF_SEARCH_URL = 'https://search.openfoodfacts.org';
const OFF_FIELDS =
  'code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per';
const USDA_URL = 'https://api.nal.usda.gov/fdc';
const USDA_DATA_TYPES = 'Foundation,SR Legacy,Branded';
const SEARCH_LIMIT = 20;

const offProduct = (gtin) => {
  const url = new URL(`${OFF_URL}/api/v2/product/${gtin}.json`);
  url.searchParams.set('fields', OFF_FIELDS);
  return url;
};

const offSearch = (q) => {
  const url = new URL(`${OFF_SEARCH_URL}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('page_size', String(SEARCH_LIMIT));
  url.searchParams.set('fields', OFF_FIELDS);
  return url;
};

const usdaSearch = (q) => {
  const url = new URL(`${USDA_URL}/v1/foods/search`);
  url.searchParams.set('query', q);
  url.searchParams.set('pageSize', String(SEARCH_LIMIT));
  url.searchParams.set('dataType', USDA_DATA_TYPES);
  return url;
};

const usdaFood = (fdcId) => new URL(`${USDA_URL}/v1/food/${fdcId}`);

const OFF = [
  ['coca-cola', offProduct('0049000000443')],
  ['lays', offProduct('0028400090858')],
  ['nutella', offProduct('3017620422003')],
  ['progresso', offProduct('0041196910759')],
  ['pecorino', offProduct('2000000000008')],
  ['unknown', offProduct('0028400999991')],
  ['search-greek-yogurt', offSearch('greek yogurt')],
];

async function record(source, name, url, headers, secret) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent, ...headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${source}/${name}: HTTP ${res.status} answered with a body that is not JSON`);
  }
  const fixture = { request: url.toString(), status: res.status, recordedAt: new Date().toISOString(), body };
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (secret && json.includes(secret)) throw new Error(`${source}/${name}: the response contains the API key; not written`);
  const dir = join(root, 'test', 'fixtures', source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), json);
  process.stdout.write(`${source}/${name}.json  HTTP ${res.status}  ${url}\n`);
  return body;
}

async function recordOff() {
  for (const [name, url] of OFF) await record('off', name, url, {});
}

async function recordUsda(key) {
  const headers = { 'X-Api-Key': key };
  const search = await record('usda', 'search-banana', usdaSearch('banana'), headers, key);
  const foods = Array.isArray(search?.foods) ? search.foods : [];
  const generic = foods.find((f) => f.dataType === 'Foundation' || f.dataType === 'SR Legacy');
  const branded = foods.find((f) => f.dataType === 'Branded' && f.gtinUpc);
  if (!generic || !branded) throw new Error('usda: the banana search lacks a generic food or a branded food with a gtinUpc');
  await record('usda', 'food-generic', usdaFood(generic.fdcId), headers, key);
  await record('usda', 'food-branded', usdaFood(branded.fdcId), headers, key);
}

const wanted = process.argv.slice(2);
const wants = (source) => wanted.length === 0 || wanted.includes(source);

if (wants('off')) await recordOff();
if (wants('usda')) {
  const key = process.env.USDA_API_KEY?.trim();
  if (key) await recordUsda(key);
  else process.stdout.write('usda: skipped, USDA_API_KEY is not set (tokenstash writes it to ../.env.local)\n');
}
