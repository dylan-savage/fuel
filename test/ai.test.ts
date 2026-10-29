import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { completeFood, nutrientsFor } from '../src/domain/food.js';
import { FoodId } from '../src/domain/ids.js';
import { estimateItem, type FoodHint } from '../src/domain/quicklog.js';
import type { AiParseRequest } from '../src/protocol.js';
import { createAiParser, labelCandidate, type AiOutcome, type LabelReply } from '../src/server/ai.js';
import { BREAKFAST, breakfastReply, labelReply, message, photo, plateReply, replyOf, stubMessages } from './ai-replies.js';

const foods: FoodHint[] = [
  { key: 'food:egg', name: 'Egg', brand: 'Vital Farms' },
  { key: 'food:oats', name: 'Overnight oats' },
];
const text: AiParseRequest = { kind: 'text', text: BREAKFAST, foods };
const plate: AiParseRequest = { kind: 'photo', subject: 'plate', mediaType: 'image/jpeg', base64: photo('plate'), foods };
const label: AiParseRequest = { kind: 'photo', subject: 'label', mediaType: 'image/jpeg', base64: photo('label'), foods: [] };

async function parseWith(reply: Parameters<typeof stubMessages>[0], req: AiParseRequest = text) {
  const messages = stubMessages(reply);
  const outcome = await createAiParser({ messages, model: 'claude-opus-5-5' }).parse(req);
  return { outcome, sent: messages.sent };
}

function answer(outcome: AiOutcome) {
  if (!outcome.ok) throw new Error(`expected an answer, got ${outcome.reason}`);
  return outcome.answer;
}

function drafts(outcome: AiOutcome) {
  const a = answer(outcome);
  if (a.kind !== 'drafts') throw new Error(`expected drafts, got ${a.kind}`);
  return a.drafts;
}

describe('a description', () => {
  it("answers drafts, with the oats matched to Dylan's own food", async () => {
    const { outcome } = await parseWith(breakfastReply(2));
    const [eggs, toast, butter, oats] = drafts(outcome);
    expect(eggs).toEqual({
      name: 'Egg',
      amount: { described: '2', count: 2, countUnit: 'egg', grams: 100, ml: null },
      nutrients: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, sodium: 142 },
      confidence: 'high',
      match: null,
    });
    expect(toast?.nutrients.fiber).toBe(1.2);
    expect(butter?.confidence).toBe('low');
    expect(oats?.match).toBe('food:oats');
    expect(oats?.amount).toEqual({ described: 'my usual', count: null, countUnit: null, grams: null, ml: null });
  });

  it('matches nothing when the model names a food past the end of the list', async () => {
    const { outcome } = await parseWith(breakfastReply(3));
    expect(drafts(outcome).at(-1)?.match).toBeNull();
  });

  it('asks the model for structured output at low effort, with the refusal fallback on and his foods numbered', async () => {
    const { sent } = await parseWith(breakfastReply(null));
    const [call] = sent;
    expect(call?.params).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(call?.params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: `Dylan's foods:\n1. Egg (Vital Farms)\n2. Overnight oats\n\nWhat he ate: ${BREAKFAST}` }] },
    ]);
    expect(call?.options).toEqual({ timeout: 25_000, maxRetries: 1 });
  });
});

describe('a plate photo', () => {
  it('sends the photo and answers a draft per food on the plate', async () => {
    const { outcome, sent } = await parseWith(plateReply, plate);
    const content = sent[0]?.params.messages[0]?.content;
    expect(Array.isArray(content) ? content[0] : null).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo('plate') } });
    const found = drafts(outcome);
    expect(found.map((d) => d.name)).toEqual(['French toast', 'Fried egg', 'Corned beef hash', 'Butter', 'Maple syrup']);
    const syrup = found.at(-1);
    if (!syrup) throw new Error('no syrup');
    expect(estimateItem(syrup).food.unit).toBe('ml');
  });
});

describe('a label photo', () => {
  it('answers a food per 100 g with the printed serving, which logs as printed', async () => {
    const candidate = answer((await parseWith(labelReply, label)).outcome);
    if (candidate.kind !== 'label') throw new Error('expected a label');
    expect(candidate.candidate).toMatchObject({
      name: 'Cheerios',
      brand: 'General Mills',
      unit: 'g',
      servings: [{ label: '1 cup', amount: 28 }],
      barcodes: [],
      source: { kind: 'ai', from: 'label' },
    });
    const completed = completeFood(candidate.candidate, FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100'));
    if (!completed.ok) throw new Error('incomplete');
    const cup = nutrientsFor({ ...completed.food, origin: { kind: 'adhoc' } }, { kind: 'serving', serving: { label: '1 cup', amount: 28 }, count: 1 });
    expect(cup.kcal).toBeCloseTo(100);
    expect(cup.sodium).toBeCloseTo(140);
  });
});

describe('labelCandidate', () => {
  const panel: LabelReply = {
    readable: true,
    name: "Lay's Classic",
    brand: null,
    per: 'serving',
    servingLabel: '1 package',
    servingGrams: null,
    servingMl: null,
    kcal: 160,
    protein: null,
    carbs: 15,
    fat: 10,
    fiber: 1,
    sugar: null,
    sodiumMg: 170,
  };

  it('measures a serving with no printed weight in portions', () => {
    expect(labelCandidate(panel)).toMatchObject({ unit: 'portion', nutrients: { kcal: 160 }, servings: [{ label: '1 package', amount: 1 }] });
  });

  it('leaves an unread core nutrient missing, so the confirm sheet asks for it', () => {
    expect(completeFood(labelCandidate(panel), FoodId.parse('0f0e0d0c-0b0a-4908-8706-050403020100'))).toEqual({ ok: false, missing: ['protein'] });
  });

  it('keeps values printed per 100 ml as they are', () => {
    expect(labelCandidate({ ...panel, per: '100ml', servingMl: 330, protein: 0 })).toMatchObject({
      unit: 'ml',
      nutrients: { kcal: 160, protein: 0 },
      servings: [{ label: '1 package', amount: 330 }],
    });
  });
});

describe('failures', () => {
  const reasonOf = async (reply: Parameters<typeof stubMessages>[0], req: AiParseRequest = text) => {
    const { outcome } = await parseWith(reply, req);
    return outcome.ok ? 'answered' : outcome.reason;
  };

  it('calls a reply that is not JSON, or not the schema, unreadable', async () => {
    expect(await reasonOf(message({ content: [{ type: 'text', text: 'Two eggs, about 140 kcal.', citations: null }] }))).toBe('ai_unreadable');
    expect(await reasonOf(replyOf({ items: [{ name: 'Egg' }] }))).toBe('ai_unreadable');
    const negative = { name: 'Egg', described: '', count: null, countUnit: null, grams: 50, ml: null, kcal: -5, protein: 1, carbs: 1, fat: 1 };
    expect(await reasonOf(replyOf({ items: [{ ...negative, fiber: null, sugar: null, sodiumMg: null, confidence: 'high', yours: null }] }))).toBe('ai_unreadable');
  });

  it('calls a reply cut off at max_tokens unreadable, even when its text parses', async () => {
    expect(await reasonOf({ ...breakfastReply(null), stop_reason: 'max_tokens' })).toBe('ai_unreadable');
  });

  it('reports a refusal', async () => {
    const refused = message({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null },
    });
    expect(await reasonOf(refused)).toBe('ai_refused');
  });

  it('reads the answer after a fallback took over from a declining model', async () => {
    const handedOver = message({
      model: 'claude-opus-5',
      content: [
        { type: 'text', text: '{"items": [{"na', citations: null },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: null } },
        ...breakfastReply(null).content,
      ],
    });
    expect(drafts((await parseWith(handedOver)).outcome)).toHaveLength(4);
  });

  it('reports a timeout apart from the API being out of reach or erroring', async () => {
    const thrower = (err: Error) => () => {
      throw err;
    };
    expect(await reasonOf(thrower(new Anthropic.APIConnectionTimeoutError()))).toBe('ai_timeout');
    expect(await reasonOf(thrower(new Anthropic.APIConnectionError({ message: 'ECONNRESET' })))).toBe('ai_unavailable');
    expect(await reasonOf(thrower(Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error' } }, 'Overloaded', new Headers())))).toBe('ai_unavailable');
  });

  it('finds nothing when the model lists no food or reads no label', async () => {
    expect(await reasonOf(replyOf({ items: [] }))).toBe('ai_nothing_found');
    const nothing: LabelReply = {
      readable: false,
      name: '',
      brand: null,
      per: 'serving',
      servingLabel: null,
      servingGrams: null,
      servingMl: null,
      kcal: null,
      protein: null,
      carbs: null,
      fat: null,
      fiber: null,
      sugar: null,
      sodiumMg: null,
    };
    expect(await reasonOf(replyOf(nothing), label)).toBe('ai_nothing_found');
  });
});
