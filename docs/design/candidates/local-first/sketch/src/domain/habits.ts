import { z } from 'zod';
import { todo } from '../todo.js';
import { FastId, LocalDate, Millis, WaterId } from './ids.js';

/**
 * One drink. Water is append-only rows, never a per-day counter, so two replicas adding
 * water offline both count after sync. Synced doc kind 'water'.
 */
export const WaterLog = z.object({
  id: WaterId,
  date: LocalDate,
  ml: z.number().positive().max(5000),
  at: Millis,
});
export type WaterLog = z.infer<typeof WaterLog>;

export function waterTotalMl(logs: readonly WaterLog[]): number {
  return todo(`waterTotalMl(${logs.length})`);
}

/** An intermittent fast. Open while endedAt is null. Synced doc kind 'fast'. */
export const Fast = z
  .object({
    id: FastId,
    startedAt: Millis,
    endedAt: Millis.nullable(),
    targetHours: z.number().positive().max(72),
  })
  .refine((f) => f.endedAt === null || f.endedAt > f.startedAt, 'a fast ends after it starts');
export type Fast = z.infer<typeof Fast>;

export type FastStatus =
  | { readonly kind: 'idle'; readonly last: Fast | null }
  | { readonly kind: 'fasting'; readonly fast: Fast; readonly elapsedMs: number; readonly targetMs: number }
  /** Two replicas each started a fast offline. Shown once; ending the newest closes both. */
  | { readonly kind: 'overlap'; readonly open: readonly Fast[] };

/** Derives the timer state from fast docs. There is no stored "active fast" flag to keep in sync. */
export function fastStatus(fasts: readonly Fast[], now: Millis): FastStatus {
  return todo(`fastStatus(${fasts.length}, ${now})`);
}
