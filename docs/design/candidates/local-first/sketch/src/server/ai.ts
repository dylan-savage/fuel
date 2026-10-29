/**
 * Anthropic adapter for AI quick log. The API key exists only in this process's env. The
 * model's structured output is parsed into domain drafts here, and nothing is written:
 * the phone writes entries after Dylan confirms them.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { todo } from '../todo.js';
import type { AiResult, Draft, Food, FoodCandidate } from '../domain/food.js';
import type { Nutrients } from '../domain/nutrients.js';
import type { AiParseRequest } from '../protocol.js';

export interface AiParser {
  /**
   * text or plate photo -> 'drafts'; label photo -> 'label'; refusal, null parsed_output
   * or zero items -> 'unreadable'. Library foods are matched by name so "2 eggs" reuses
   * Dylan's own egg food instead of an estimate.
   *
   * Call shape (verified against the claude-api skill on 2026-10-28):
   *   client.messages.parse({
   *     model,                                     // FUEL_AI_MODEL, default 'claude-opus-5-5'
   *     max_tokens: 4000,
   *     output_config: { format: zodOutputFormat(ParsedItems), effort: 'low' },
   *     system: SYSTEM_PROMPT,                     // frozen string, cacheable
   *     messages: [{ role: 'user', content: [imageBlock?, { type: 'text', text }] }],
   *   })
   *   check stop_reason !== 'refusal' and parsed_output !== null before reading.
   * zodOutputFormat comes from '@anthropic-ai/sdk/helpers/zod'.
   */
  parse(req: AiParseRequest, library: readonly Food[]): Promise<AiResult>;
}

export function createAiParser(cfg: { client: Anthropic; model: string }): AiParser {
  return todo(`createAiParser(${cfg.model})`);
}

/**
 * What the model returns for text and plate photos (the zod schema behind ParsedItems).
 * Optional values are nullable rather than absent, which suits structured outputs.
 */
export interface ParsedItem {
  readonly name: string;
  readonly brand: string | null;
  /** How the user or photo described the amount: "2 large", "1 slice", "about a cup". */
  readonly amountText: string;
  readonly grams: number | null;
  /** For the whole described amount, not per 100 g. */
  readonly nutrients: Nutrients;
  readonly confidence: 'low' | 'medium' | 'high';
}

/** What the model returns for a nutrition label photo. */
export interface ParsedLabel {
  readonly name: string;
  readonly brand: string | null;
  readonly servingLabel: string;
  readonly servingGrams: number | null;
  readonly servingMl: number | null;
  readonly perServing: Nutrients;
}

/** Pure. Token-overlap match of a parsed name against library foods; null below threshold. */
export function matchLibrary(name: string, library: readonly Food[]): Food | null {
  return todo(`matchLibrary(${name}, ${library.length})`);
}

/**
 * Pure. Matched items become the library food's snapshot with a quantity derived from grams
 * or amountText; unmatched items become adhoc snapshots (unit g, per = grams, when grams is
 * known; else unit portion, per 1) carrying the model's nutrients.
 */
export function toDrafts(items: readonly ParsedItem[], library: readonly Food[]): Draft[] {
  return todo(`toDrafts(${items.length}, ${library.length})`);
}

/** Pure. Label to a candidate normalized to per 100 g/ml when a serving weight is printed. */
export function labelToCandidate(label: ParsedLabel): FoodCandidate | null {
  return todo(`labelToCandidate(${label.name})`);
}
