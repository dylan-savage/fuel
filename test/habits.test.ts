import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATER_ML,
  HOUR_MS,
  endOpen,
  fastHistory,
  fastProgress,
  fastState,
  fastStreak,
  nextTargetHours,
  runningFast,
  waterGoalMl,
  waterTotalMl,
  type Fast,
  type Water,
} from '../src/domain/habits.js';
import { FastId, LocalDate, Millis, WaterId } from '../src/domain/ids.js';
import { goal } from './fixtures.js';

const today = LocalDate.parse('2026-10-28');
/** 2026-10-28T20:00Z. */
const NOW = Millis.parse(Date.parse('2026-10-28T20:00:00Z'));
const ms = (iso: string) => Millis.parse(Date.parse(iso));
const utcDay = (at: Millis) => LocalDate.parse(new Date(at).toISOString().slice(0, 10));

function fast(startedAt: string, endedAt?: string, targetHours = 16): Fast {
  return { id: FastId.parse(randomUUID()), startedAt: ms(startedAt), ...(endedAt === undefined ? {} : { endedAt: ms(endedAt) }), targetHours };
}

describe('water', () => {
  const drink = (ml: number): Water => ({ id: WaterId.parse(randomUUID()), date: today, ml, loggedAt: NOW });

  it('adds up every drink, so two drinks from two phones both count', () => {
    expect(waterTotalMl([drink(250), drink(500), drink(250)])).toBe(1000);
    expect(waterTotalMl([])).toBe(0);
  });

  it("takes the day's goal from the goal in effect, else 64 fl oz", () => {
    expect(waterGoalMl({ ...goal(today, 2000), waterMl: 3000 })).toBe(3000);
    expect(waterGoalMl(goal(today, 2000))).toBeCloseTo(1892.7, 1);
    expect(waterGoalMl(undefined)).toBe(DEFAULT_WATER_ML);
  });
});

describe('fast state', () => {
  it('is idle with no open fast, and fasting with one', () => {
    expect(fastState([])).toEqual({ kind: 'idle' });
    const done = fast('2026-10-27T20:00Z', '2026-10-28T12:00Z');
    expect(fastState([done])).toEqual({ kind: 'idle' });
    const open = fast('2026-10-28T19:00Z');
    expect(fastState([done, open])).toEqual({ kind: 'fasting', fast: open });
  });

  it('shows two open fasts, one per offline phone, as an overlap timed from the earliest', () => {
    const phone = fast('2026-10-28T12:00Z');
    const laptop = fast('2026-10-28T10:00Z');
    const state = fastState([phone, laptop]);
    expect(state).toEqual({ kind: 'overlap', open: [laptop, phone] });
    expect(runningFast(state)).toBe(laptop);
  });

  it('ends every open fast, which settles the overlap back to idle', () => {
    const fasts = [fast('2026-10-28T12:00Z'), fast('2026-10-28T10:00Z'), fast('2026-10-27T10:00Z', '2026-10-28T02:00Z')];
    const ended = endOpen(fasts, NOW);
    expect(ended.map((f) => f.endedAt)).toEqual([NOW, NOW]);
    const byId = new Map([...fasts, ...ended].map((f) => [f.id, f]));
    expect(fastState([...byId.values()])).toEqual({ kind: 'idle' });
  });

  it('ends a fast started by a phone with a fast clock where it began, never before', () => {
    const ahead = fast('2026-10-28T21:00Z');
    expect(endOpen([ahead], NOW)[0]?.endedAt).toBe(ahead.startedAt);
  });

  it('times elapsed and remaining against the target', () => {
    expect(fastProgress(fast('2026-10-28T06:00Z'), NOW)).toEqual({ elapsedMs: 14 * HOUR_MS, targetMs: 16 * HOUR_MS, remainingMs: 2 * HOUR_MS, reached: false });
    expect(fastProgress(fast('2026-10-28T02:00Z'), NOW)).toMatchObject({ remainingMs: 0, reached: true });
    expect(fastProgress(fast('2026-10-28T02:00Z', '2026-10-28T12:00Z'), NOW).elapsedMs).toBe(10 * HOUR_MS);
  });

  it('starts the next fast with the latest target, 16 hours before any', () => {
    expect(nextTargetHours([])).toBe(16);
    expect(nextTargetHours([fast('2026-10-26T20:00Z', '2026-10-27T14:00Z', 18), fast('2026-10-27T20:00Z', '2026-10-28T10:00Z', 14)])).toBe(14);
  });
});

describe('fast history', () => {
  it('lists finished fasts newest first and merges two phones overlapping fasts into one', () => {
    const history = fastHistory([
      fast('2026-10-26T20:00Z', '2026-10-27T12:00Z'),
      fast('2026-10-27T20:00Z', '2026-10-28T12:00Z'),
      fast('2026-10-27T21:00Z', '2026-10-28T12:00Z'),
      fast('2026-10-28T19:00Z'),
    ]);
    expect(history).toEqual([
      { startedAt: ms('2026-10-27T20:00Z'), endedAt: ms('2026-10-28T12:00Z'), targetHours: 16 },
      { startedAt: ms('2026-10-26T20:00Z'), endedAt: ms('2026-10-27T12:00Z'), targetHours: 16 },
    ]);
  });
});

describe('fast streaks', () => {
  /** A fast ending at 12:00 UTC on the day, lasting `hours`. */
  const endingOn = (day: string, hours = 16) => {
    const end = ms(`${day}T12:00:00Z`);
    return { id: FastId.parse(randomUUID()), startedAt: Millis.parse(end - hours * HOUR_MS), endedAt: end, targetHours: 16 };
  };
  const streak = (fasts: Fast[]) => fastStreak(fastHistory(fasts), { today, dayOf: utcDay });

  it('counts days in a row that finished a fast on target', () => {
    expect(streak(['2026-10-26', '2026-10-27', '2026-10-28'].map((d) => endingOn(d)))).toEqual({ current: 3, best: 3 });
  });

  it('keeps the streak through today until today is over', () => {
    expect(streak(['2026-10-26', '2026-10-27'].map((d) => endingOn(d))).current).toBe(2);
  });

  it('breaks on a missed day or a fast short of its target, and remembers the best run', () => {
    const fasts = [
      ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((d) => endingOn(d)),
      endingOn('2026-10-26'),
      endingOn('2026-10-27', 12),
      endingOn('2026-10-28'),
    ];
    expect(streak(fasts)).toEqual({ current: 1, best: 4 });
    expect(streak([])).toEqual({ current: 0, best: 0 });
  });
});
