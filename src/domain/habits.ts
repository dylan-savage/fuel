import { z } from 'zod';
import type { Goal } from './goals.js';
import { FastId, LocalDate, Millis, WaterId, addDays } from './ids.js';

export const ML_PER_FL_OZ = 29.5735295625;
export const HOUR_MS = 3_600_000;

/**
 * One drink. Water is a document per drink, never a day counter, so drinks added offline on
 * two phones both count once they sync. Synced document kind 'water'.
 */
export const Water = z.looseObject({
  id: WaterId,
  date: LocalDate,
  ml: z.number().positive().max(5000),
  loggedAt: Millis,
});
export type Water = z.infer<typeof Water>;

/** The daily water goal until a goal sets one: 64 fl oz, the familiar eight glasses. */
export const DEFAULT_WATER_ML = 64 * ML_PER_FL_OZ;

export function waterTotalMl(drinks: readonly Water[]): number {
  return drinks.reduce((sum, drink) => sum + drink.ml, 0);
}

/** The water goal of the goal in effect, else the default. */
export function waterGoalMl(goal: Goal | undefined): number {
  return goal?.waterMl ?? DEFAULT_WATER_ML;
}

/**
 * An intermittent fast, open until it has an end. The start is the phone's clock when Dylan
 * tapped Start, so a fast started offline keeps its real start. Synced document kind 'fast'.
 */
export const Fast = z
  .looseObject({
    id: FastId,
    startedAt: Millis,
    endedAt: Millis.optional(),
    targetHours: z.number().positive().max(168),
  })
  .refine((fast) => fast.endedAt === undefined || fast.endedAt >= fast.startedAt, 'a fast ends after it starts');
export type Fast = z.infer<typeof Fast>;

/** 16:8, until Dylan picks another target. */
export const DEFAULT_FAST_HOURS = 16;

/**
 * Whether Dylan is fasting, derived from the fast documents, so no stored flag can drift.
 * `overlap` is two phones each starting a fast while offline. It shows the earliest, and
 * ending the fast ends them all.
 */
export type FastState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'fasting'; readonly fast: Fast }
  | { readonly kind: 'overlap'; readonly open: readonly [Fast, Fast, ...Fast[]] };

export function fastState(fasts: readonly Fast[]): FastState {
  const [first, second, ...rest] = fasts.filter((f) => f.endedAt === undefined).toSorted((a, b) => a.startedAt - b.startedAt);
  if (first === undefined) return { kind: 'idle' };
  if (second === undefined) return { kind: 'fasting', fast: first };
  return { kind: 'overlap', open: [first, second, ...rest] };
}

/** The fast a timer shows: the only open one, or the earliest of an overlap. */
export function runningFast(state: FastState): Fast | undefined {
  switch (state.kind) {
    case 'idle':
      return undefined;
    case 'fasting':
      return state.fast;
    case 'overlap':
      return state.open[0];
  }
}

/** The target the next fast starts with: the latest fast's, so a changed target sticks. */
export function nextTargetHours(fasts: readonly Fast[]): number {
  const [latest] = fasts.toSorted((a, b) => b.startedAt - a.startedAt);
  return latest?.targetHours ?? DEFAULT_FAST_HOURS;
}

/** Every open fast, ended at `now`. A start from a phone whose clock runs ahead ends where it began. */
export function endOpen(fasts: readonly Fast[], now: Millis): Fast[] {
  return fasts.filter((f) => f.endedAt === undefined).map((f) => ({ ...f, endedAt: Millis.parse(Math.max(now, f.startedAt)) }));
}

export interface FastProgress {
  readonly elapsedMs: number;
  readonly targetMs: number;
  readonly remainingMs: number;
  readonly reached: boolean;
}

export function fastProgress(fast: Pick<Fast, 'startedAt' | 'endedAt' | 'targetHours'>, now: Millis): FastProgress {
  const elapsedMs = Math.max(0, (fast.endedAt ?? now) - fast.startedAt);
  const targetMs = fast.targetHours * HOUR_MS;
  return { elapsedMs, targetMs, remainingMs: Math.max(0, targetMs - elapsedMs), reached: elapsedMs >= targetMs };
}

/** A finished fast as history shows it. */
export interface FastSession {
  readonly startedAt: Millis;
  readonly endedAt: Millis;
  readonly targetHours: number;
}

/**
 * Finished fasts, newest first. Fasts whose times overlap, the two-phone case, count as one
 * session from the first start to the last end, with the first one's target.
 */
export function fastHistory(fasts: readonly Fast[]): FastSession[] {
  const sessions: FastSession[] = [];
  for (const fast of fasts.toSorted((a, b) => a.startedAt - b.startedAt)) {
    if (fast.endedAt === undefined) continue;
    const last = sessions.at(-1);
    if (last !== undefined && fast.startedAt <= last.endedAt) {
      sessions[sessions.length - 1] = { ...last, endedAt: Millis.parse(Math.max(last.endedAt, fast.endedAt)) };
    } else {
      sessions.push({ startedAt: fast.startedAt, endedAt: fast.endedAt, targetHours: fast.targetHours });
    }
  }
  return sessions.reverse();
}

export interface Streak {
  /** Days in a row, ending today or yesterday, that finished a fast on target. */
  readonly current: number;
  readonly best: number;
}

/**
 * Streaks count local days that finished a fast on target, by the day it ended. Today does
 * not break the current streak before it is over. `dayOf` is the phone's calendar.
 */
export function fastStreak(history: readonly FastSession[], at: { readonly today: LocalDate; readonly dayOf: (at: Millis) => LocalDate }): Streak {
  const days = new Set(history.filter((s) => fastProgress(s, s.endedAt).reached).map((s) => at.dayOf(s.endedAt)));
  const runFrom = (day: LocalDate, step: 1 | -1) => {
    let length = 0;
    for (let d = day; days.has(d); d = addDays(d, step)) length++;
    return length;
  };
  const current = runFrom(days.has(at.today) ? at.today : addDays(at.today, -1), -1);
  const best = Math.max(0, ...[...days].filter((d) => !days.has(addDays(d, -1))).map((d) => runFrom(d, 1)));
  return { current, best };
}
