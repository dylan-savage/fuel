/**
 * Model replies in the exact shape `client.beta.messages.create` returns, typed against the
 * SDK so a shape change fails to compile. Hand-written from the photos in test/fixtures/ai
 * until the API key lands; scripts/ai-smoke.mjs prints real ones to compare.
 */
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesApi } from '../src/server/ai.js';

type Message = Anthropic.Beta.Messages.BetaMessage;
type CreateParams = Parameters<MessagesApi['create']>[0];
type CreateOptions = Parameters<MessagesApi['create']>[1];

export function message(fields: Partial<Message>): Message {
  return {
    id: 'msg_01FuelFixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    container: null,
    context_management: null,
    diagnostics: null,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: 'global',
      input_tokens: 900,
      iterations: null,
      output_tokens: 240,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: 'standard',
    },
    ...fields,
  };
}

/** A reply whose only content is the model's JSON. */
export const replyOf = (json: unknown): Message => message({ content: [{ type: 'text', text: JSON.stringify(json), citations: null }] });

export const BREAKFAST = '2 eggs, sourdough toast with butter and my usual oats';

const item = {
  brand: null,
  ml: null,
  fiber: null,
  sugar: null,
  sodiumMg: null,
  confidence: 'medium',
  yours: null,
};

/** The breakfast, with the oats matched to the food Dylan's list numbers `oats`. */
export function breakfastReply(oats: number | null): Message {
  return replyOf({
    items: [
      { ...item, name: 'Egg', described: '2', count: 2, countUnit: 'egg', grams: 100, kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, sodiumMg: 142, confidence: 'high' },
      { ...item, name: 'Sourdough toast', described: '1 slice', count: 1, countUnit: 'slice', grams: 50, kcal: 145, protein: 5.8, carbs: 28, fat: 1, fiber: 1.2 },
      { ...item, name: 'Butter', described: 'a pat on the toast', count: 1, countUnit: 'pat', grams: 7, kcal: 50, protein: 0.1, carbs: 0, fat: 5.7, confidence: 'low' },
      { ...item, name: 'Overnight oats', described: 'my usual', count: null, countUnit: null, grams: null, kcal: 380, protein: 18, carbs: 52, fat: 11, yours: oats },
    ],
  });
}

/** test/fixtures/ai/plate.jpg, judged by eye. */
export const plateReply = replyOf({
  items: [
    { ...item, name: 'French toast', described: '2 slices', count: 2, countUnit: 'slice', grams: 200, kcal: 460, protein: 15, carbs: 52, fat: 21 },
    { ...item, name: 'Fried egg', described: '2', count: 2, countUnit: 'egg', grams: 92, kcal: 180, protein: 12.5, carbs: 0.8, fat: 14, confidence: 'high' },
    { ...item, name: 'Corned beef hash', described: 'about a cup', count: null, countUnit: null, grams: 190, kcal: 400, protein: 19, carbs: 22, fat: 26, sodiumMg: 970 },
    { ...item, name: 'Butter', described: '1 pat', count: 1, countUnit: 'pat', grams: 5, kcal: 36, protein: 0, carbs: 0, fat: 4.1 },
    { ...item, name: 'Maple syrup', described: '1 small cup', ml: 45, count: 1, countUnit: 'cup', grams: null, kcal: 156, protein: 0, carbs: 40, fat: 0, sugar: 36, confidence: 'low' },
  ],
});

/** test/fixtures/ai/label.jpg, the Cheerios column of the panel. */
export const labelReply = replyOf({
  readable: true,
  name: 'Cheerios',
  brand: 'General Mills',
  per: 'serving',
  servingLabel: '1 cup',
  servingGrams: 28,
  servingMl: null,
  kcal: 100,
  protein: 3,
  carbs: 20,
  fat: 2,
  fiber: 3,
  sugar: 1,
  sodiumMg: 140,
});

export const photo = (name: 'label' | 'plate'): string => readFileSync(new URL(`fixtures/ai/${name}.jpg`, import.meta.url)).toString('base64');

/** A stand-in for `client.beta.messages` that answers with `reply` and keeps what it was sent. */
export function stubMessages(reply: Message | (() => Message)): MessagesApi & { readonly sent: { readonly params: CreateParams; readonly options: CreateOptions }[] } {
  const sent: { params: CreateParams; options: CreateOptions }[] = [];
  return {
    sent,
    create: (params, options) => {
      sent.push({ params, options });
      try {
        return Promise.resolve(typeof reply === 'function' ? reply() : reply);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
