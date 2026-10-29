// Calls the real Anthropic API through the built adapter for one description, one label photo
// and one plate photo from test/fixtures/ai, and prints each answer with its latency. Name
// several models to compare them side by side.
//
//   npm run build
//   node --env-file-if-exists=../.env.local scripts/ai-smoke.mjs [model ...]
//
// With no model named it uses FUEL_AI_MODEL, else the server's default. ANTHROPIC_API_KEY is
// read by the SDK from the environment and never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, createAiParser } from '../dist/server/ai.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

if (!process.env.ANTHROPIC_API_KEY) {
  out('ANTHROPIC_API_KEY is not set, so there is nothing to call. tokenstash writes it to ../.env.local.');
  process.exit(1);
}

const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures', 'ai');
const photo = (name) => readFileSync(join(fixtures, `${name}.jpg`)).toString('base64');
/** Dylan's foods as the phone would send them, so "my usual oats" has something to match. */
const foods = [
  { key: 'food:oats', name: 'Overnight oats' },
  { key: 'food:egg', name: 'Egg', brand: 'Vital Farms' },
  { key: 'food:sourdough', name: 'Sourdough toast' },
];

const requests = [
  ['text', { kind: 'text', text: '2 eggs, sourdough toast with butter and my usual oats', foods }],
  ['label', { kind: 'photo', subject: 'label', mediaType: 'image/jpeg', base64: photo('label'), foods: [] }],
  ['plate', { kind: 'photo', subject: 'plate', mediaType: 'image/jpeg', base64: photo('plate'), foods }],
];

const round = (n) => (n === undefined ? '-' : Math.round(n * 10) / 10);

function show(outcome) {
  if (!outcome.ok) return out(`  failed: ${outcome.reason}`);
  const { answer } = outcome;
  if (answer.kind === 'label') {
    const { candidate } = answer;
    out(`  ${candidate.name}${candidate.brand ? ` (${candidate.brand})` : ''}, per ${candidate.unit === 'portion' ? 'portion' : `100 ${candidate.unit}`}`);
    out(`  servings: ${candidate.servings.map((s) => `${s.label} = ${s.amount}`).join(', ') || 'none'}`);
    out(`  nutrients: ${Object.entries(candidate.nutrients).map(([k, v]) => `${k} ${round(v)}`).join(', ')}`);
    return;
  }
  for (const draft of answer.drafts) {
    const { count, countUnit, grams, ml, described } = draft.amount;
    const amount = [count === null ? null : `${count} ${countUnit ?? ''}`.trim(), grams === null ? null : `${grams} g`, ml === null ? null : `${ml} ml`].filter(Boolean).join(', ');
    const n = draft.nutrients;
    out(`  ${draft.name}: "${described}" ${amount ? `(${amount}) ` : ''}${round(n.kcal)} kcal, P ${round(n.protein)} C ${round(n.carbs)} F ${round(n.fat)}, ${draft.confidence}${draft.match ? `, matches ${draft.match}` : ''}`);
  }
}

const models = process.argv.slice(2);
const client = new Anthropic();
for (const model of models.length > 0 ? models : [process.env.FUEL_AI_MODEL || DEFAULT_MODEL]) {
  const parser = createAiParser({ messages: client.beta.messages, model });
  for (const [name, req] of requests) {
    const started = performance.now();
    const outcome = await parser.parse(req);
    out(`${model}  ${name}  ${Math.round(performance.now() - started)} ms`);
    show(outcome);
    out();
  }
}
