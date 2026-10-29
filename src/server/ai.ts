import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FoodCandidate, type Serving } from '../domain/food.js';
import { NUTRIENTS, type NutrientKey, type PartialNutrients } from '../domain/nutrients.js';
import { Draft, type FoodHint } from '../domain/quicklog.js';
import type { FoodUnit } from '../domain/units.js';
import type { AiAnswer, AiFailure, AiParseRequest } from '../protocol.js';
import { log } from './log.js';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type Content = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface MessagesApi {
  create(params: CreateParams, options: { readonly timeout: number; readonly maxRetries: number }): Promise<Message>;
}

export type AiOutcome = { readonly ok: true; readonly answer: AiAnswer } | { readonly ok: false; readonly reason: AiFailure };

export interface AiParser {
  parse(req: AiParseRequest): Promise<AiOutcome>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORT = 'low';
/** The model names one of Dylan's foods by its number in the list it was sent. */
const FIRST_HINT = 1;

const TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1;

const ItemReply = z.object({
  name: z.string().describe('Short and singular, as a food log lists it: "Fried egg", "Sourdough toast"'),
  brand: z.string().nullable(),
  described: z.string().describe('The amount in his words or as seen: "2 large", "about a cup"'),
  count: z.number().nullable(),
  countUnit: z.string().nullable().describe('One counted piece, singular: "egg", "slice"'),
  grams: z.number().nullable().describe('Weight of the whole amount, for food'),
  ml: z.number().nullable().describe('Volume of the whole amount, for drinks'),
  kcal: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  fiber: z.number().nullable(),
  sugar: z.number().nullable(),
  sodiumMg: z.number().nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  yours: z.number().int().nullable().describe("The number of the matching food in Dylan's list, or null"),
});
type ItemReply = z.infer<typeof ItemReply>;
const ItemsReply = z.object({ items: z.array(ItemReply) });

const LabelReply = z.object({
  readable: z.boolean(),
  name: z.string(),
  brand: z.string().nullable(),
  per: z.enum(['serving', '100g', '100ml']),
  servingLabel: z.string().nullable().describe('The household measure: "2/3 cup", "1 bar"'),
  servingGrams: z.number().nullable(),
  servingMl: z.number().nullable(),
  kcal: z.number().nullable(),
  protein: z.number().nullable(),
  carbs: z.number().nullable(),
  fat: z.number().nullable(),
  fiber: z.number().nullable(),
  sugar: z.number().nullable(),
  sodiumMg: z.number().nullable(),
});
export type LabelReply = z.infer<typeof LabelReply>;

const ITEMS_SYSTEM = `You turn a description or a photo of what Dylan ate into items for his calorie log.

Return one item per food, split the way a food log lists them: "2 eggs and toast with butter" is eggs, toast and butter. A dish eaten as one thing stays one item, such as a burrito bowl.

For each item:
- count and countUnit when the amount is countable. Give grams for food and ml for drinks too, estimating them when he gives only a count.
- kcal, protein, carbs and fat for the whole amount, not per 100 g. Fiber, sugar and sodium (mg) when you can estimate them, else null.
- confidence: high when the food and amount are clear, low when you are guessing the portion or the recipe.
- yours: the number of the food in his list when the item is clearly that food, else null. When he names one of his foods without an amount ("my usual oats"), set count, grams and ml to null, because the app then logs the amount he usually has. Still estimate nutrients for a typical serving.

Assume typical US portions and recipes for anything he leaves out. From a photo, judge each portion by eye. If there is no food, return no items.`;

const LABEL_SYSTEM = `You read a nutrition label from a photo for Dylan's calorie tracker.

- readable: false when there is no nutrition panel you can read.
- name and brand from the package when visible, else a plain description of the product.
- per: "serving" for a US Nutrition Facts panel, "100g" or "100ml" when the values are per 100.
- servingLabel is the household measure, and servingGrams or servingMl the metric serving size, usually in parentheses.
- kcal (Calories), protein, carbs (Total Carbohydrate), fat (Total Fat), fiber and sugar (Total Sugars) in grams, and sodium in mg, exactly as printed for that basis. Use null for anything you cannot read. Never estimate a value that is not printed.`;

function hintList(foods: readonly FoodHint[]): string {
  if (foods.length === 0) return "Dylan's foods: none yet.";
  return `Dylan's foods:\n${foods.map((f, i) => `${i + FIRST_HINT}. ${f.name}${f.brand === undefined ? '' : ` (${f.brand})`}`).join('\n')}`;
}

const nonNegative = (n: number | null): number | undefined => (n === null || !Number.isFinite(n) || n < 0 ? undefined : n);
const positiveOrNull = (n: number | null): number | null => (n === null || !Number.isFinite(n) || n <= 0 ? null : n);
const text = (s: string | null): string | undefined => (s === null || s.trim() === '' ? undefined : s.trim());

function nutrientsOf(reply: Pick<LabelReply, 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber' | 'sugar' | 'sodiumMg'>, factor: number): PartialNutrients {
  const readings: Readonly<Record<NutrientKey, number | null>> = { ...reply, sodium: reply.sodiumMg };
  const out: PartialNutrients = {};
  for (const { key } of NUTRIENTS) {
    const n = nonNegative(readings[key]);
    if (n !== undefined) out[key] = n * factor;
  }
  return out;
}

function draftOf(item: ItemReply, foods: readonly FoodHint[]): unknown {
  const brand = text(item.brand);
  return {
    name: item.name.trim(),
    ...(brand === undefined ? {} : { brand }),
    amount: {
      described: item.described.trim(),
      count: positiveOrNull(item.count),
      countUnit: text(item.countUnit) ?? null,
      grams: positiveOrNull(item.grams),
      ml: positiveOrNull(item.ml),
    },
    nutrients: nutrientsOf(item, 1),
    confidence: item.confidence,
    match: item.yours === null ? null : (foods[item.yours - FIRST_HINT]?.key ?? null),
  };
}

/**
 * A label as a food, per 100 g or ml when the serving's weight or volume is printed, so the
 * amount can be logged in grams; per portion when only a household measure is. Unread
 * nutrients stay missing for the confirm sheet to ask for.
 */
export function labelCandidate(label: LabelReply): FoodCandidate {
  const servingLabel = text(label.servingLabel) ?? '1 serving';
  const grams = positiveOrNull(label.servingGrams);
  const ml = positiveOrNull(label.servingMl);
  const basis = ((): { readonly unit: FoodUnit; readonly factor: number; readonly serving: Serving | null } => {
    switch (label.per) {
      case '100g':
        return { unit: 'g', factor: 1, serving: grams === null ? null : { label: servingLabel, amount: grams } };
      case '100ml':
        return { unit: 'ml', factor: 1, serving: ml === null ? null : { label: servingLabel, amount: ml } };
      case 'serving':
        if (grams !== null) return { unit: 'g', factor: 100 / grams, serving: { label: servingLabel, amount: grams } };
        if (ml !== null) return { unit: 'ml', factor: 100 / ml, serving: { label: servingLabel, amount: ml } };
        return { unit: 'portion', factor: 1, serving: { label: servingLabel, amount: 1 } };
    }
  })();
  const brand = text(label.brand);
  return {
    name: text(label.name) ?? 'Food from a label',
    ...(brand === undefined ? {} : { brand }),
    unit: basis.unit,
    nutrients: nutrientsOf(label, basis.factor),
    servings: basis.serving === null ? [] : [basis.serving],
    barcodes: [],
    source: { kind: 'ai', from: 'label' },
  };
}

/** The model's final text: after the last fallback block, when a declined model handed over mid-reply. */
function replyText(message: Message): string {
  const handover = message.content.findLastIndex((block) => block.type === 'fallback');
  return message.content
    .slice(handover + 1)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

function failureOf(err: unknown): AiFailure {
  // Connection timeouts are APIErrors too, so they go first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'ai_timeout';
  if (err instanceof Anthropic.APIError) return 'ai_unavailable';
  throw err;
}

type Asked<T> = { readonly ok: true; readonly reply: T } | { readonly ok: false; readonly reason: AiFailure };

export function createAiParser({ messages, model }: { readonly messages: MessagesApi; readonly model: string }): AiParser {
  const ask = async <T>(task: string, schema: z.ZodType<T>, system: string, content: Content[]): Promise<Asked<T>> => {
    const started = performance.now();
    const done = (fields: Readonly<Record<string, unknown>>) => log('ai_parse', { task, model, ms: Math.round(performance.now() - started), ...fields });
    let message: Message;
    try {
      message = await messages.create(
        {
          model,
          max_tokens: 16_000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: EFFORT, format: betaZodOutputFormat(schema) },
          system,
          messages: [{ role: 'user', content }],
        },
        { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
      );
    } catch (err) {
      const reason = failureOf(err);
      done({ outcome: reason, status: err instanceof Anthropic.APIError ? (err.status ?? null) : null, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, reason };
    }
    const usage = { answeredBy: message.model, stop: message.stop_reason, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    if (message.stop_reason === 'refusal') {
      done({ outcome: 'ai_refused', ...usage, category: message.stop_details?.category ?? null });
      return { ok: false, reason: 'ai_refused' };
    }
    const parsed = message.stop_reason === 'max_tokens' ? null : safeJson(replyText(message), schema);
    if (parsed === null) {
      done({ outcome: 'ai_unreadable', ...usage });
      return { ok: false, reason: 'ai_unreadable' };
    }
    done({ outcome: 'ok', ...usage });
    return { ok: true, reply: parsed };
  };

  const items = async (task: 'text' | 'plate', content: Content[], foods: readonly FoodHint[]): Promise<AiOutcome> => {
    const asked = await ask(task, ItemsReply, ITEMS_SYSTEM, content);
    if (!asked.ok) return asked;
    if (asked.reply.items.length === 0) return { ok: false, reason: 'ai_nothing_found' };
    const drafts = z.array(Draft).safeParse(asked.reply.items.map((item) => draftOf(item, foods)));
    if (!drafts.success) {
      log('ai_reply_invalid', { task, error: z.prettifyError(drafts.error) });
      return { ok: false, reason: 'ai_unreadable' };
    }
    return { ok: true, answer: { kind: 'drafts', drafts: drafts.data } };
  };

  const label = async (content: Content[]): Promise<AiOutcome> => {
    const asked = await ask('label', LabelReply, LABEL_SYSTEM, content);
    if (!asked.ok) return asked;
    if (!asked.reply.readable) return { ok: false, reason: 'ai_nothing_found' };
    const candidate = FoodCandidate.safeParse(labelCandidate(asked.reply));
    if (!candidate.success) {
      log('ai_reply_invalid', { task: 'label', error: z.prettifyError(candidate.error) });
      return { ok: false, reason: 'ai_unreadable' };
    }
    return { ok: true, answer: { kind: 'label', candidate: candidate.data } };
  };

  return {
    parse: (req) => {
      if (req.kind === 'text') return items('text', [{ type: 'text', text: `${hintList(req.foods)}\n\nWhat he ate: ${req.text}` }], req.foods);
      const image: Content = { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.base64 } };
      switch (req.subject) {
        case 'plate':
          return items('plate', [image, { type: 'text', text: `${hintList(req.foods)}\n\nLog what is on this plate.` }], req.foods);
        case 'label':
          return label([image, { type: 'text', text: 'Read the nutrition label.' }]);
      }
    },
  };
}

function safeJson<T>(reply: string, schema: z.ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(reply);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
