import { describe, expect, it } from 'vitest';
import { bodyWeightOn, projectGoal, trendSeries, weeklyRate, type WeighIn } from '../src/domain/body.js';
import { addDays, LocalDate } from '../src/domain/ids.js';
import { profile, weighIn } from './fixtures.js';

const day = (d: string) => LocalDate.parse(d);

/** A weigh-in every day for `days` days from `start`, changing by `kgPerDay`. */
function daily(start: string, days: number, fromKg: number, kgPerDay: number): WeighIn[] {
  return Array.from({ length: days }, (_, i) => weighIn(addDays(day(start), i), fromKg + i * kgPerDay));
}

describe('trendSeries', () => {
  it('seeds with the first weigh-in, moves a tenth of the way to each one, and carries across missing days', () => {
    const series = trendSeries([weighIn('2026-10-01', 100), weighIn('2026-10-02', 90), weighIn('2026-10-05', 89)], day('2026-10-06'));
    expect(series.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
    expect(series.map((p) => p.scaleKg)).toEqual([100, 90, null, null, 89, null]);
    const trend = series.map((p) => p.trendKg);
    expect(trend[0]).toBe(100);
    expect(trend[1]).toBeCloseTo(99);
    expect(trend[2]).toBeCloseTo(99);
    expect(trend[3]).toBeCloseTo(99);
    // 99 + 0.1 × (89 − 99)
    expect(trend[4]).toBeCloseTo(98);
    expect(trend[5]).toBeCloseTo(98);
  });

  it('is empty before the first weigh-in and ignores weigh-ins after the day it is read for', () => {
    expect(trendSeries([weighIn('2026-10-05', 80)], day('2026-10-04'))).toEqual([]);
    expect(trendSeries([weighIn('2026-10-01', 80), weighIn('2026-10-05', 70)], day('2026-10-03')).at(-1)?.trendKg).toBe(80);
  });

  it('moves later days when a late weigh-in fills a gap', () => {
    const before = trendSeries([weighIn('2026-10-01', 80), weighIn('2026-10-04', 80)], day('2026-10-04'));
    const after = trendSeries([weighIn('2026-10-01', 80), weighIn('2026-10-02', 70), weighIn('2026-10-04', 80)], day('2026-10-04'));
    expect(before.at(-1)?.trendKg).toBe(80);
    // 80 → 79 on the 2nd, then 79 + 0.1 × (80 − 79) on the 4th.
    expect(after.at(-1)?.trendKg).toBeCloseTo(79.1);
  });
});

describe('weeklyRate', () => {
  it('reads a steady loss from the trend once it has settled', () => {
    const series = trendSeries(daily('2026-08-01', 60, 90, -0.1), day('2026-09-29'));
    const rate = weeklyRate(series);
    expect(rate.kind).toBe('rate');
    if (rate.kind === 'rate') expect(rate.kgPerWeek).toBeCloseTo(-0.7, 1);
  });

  it('says there is not enough data before two weeks of trend', () => {
    expect(weeklyRate(trendSeries(daily('2026-10-01', 2, 90, -0.5), day('2026-10-02')))).toEqual({ kind: 'not-enough-data' });
    expect(weeklyRate(trendSeries(daily('2026-10-01', 13, 90, -0.1), day('2026-10-13')))).toEqual({ kind: 'not-enough-data' });
    expect(weeklyRate(trendSeries(daily('2026-10-01', 14, 90, -0.1), day('2026-10-14'))).kind).toBe('rate');
  });

  it('needs seven weigh-ins in the last fourteen days', () => {
    const everyOtherDay = (count: number) => Array.from({ length: count }, (_, i) => weighIn(addDays(day('2026-10-01'), i * 2), 90 - i * 0.2));
    expect(weeklyRate(trendSeries(everyOtherDay(6), day('2026-10-14')))).toEqual({ kind: 'not-enough-data' });
    expect(weeklyRate(trendSeries(everyOtherDay(7), day('2026-10-14'))).kind).toBe('rate');
  });
});

describe('projectGoal', () => {
  const from = day('2026-10-28');
  const losing = { kind: 'rate', kgPerWeek: -0.5 } as const;

  it('projects the day the trend reaches the goal at the current rate', () => {
    // 5 kg at 0.5 kg a week is 10 weeks.
    expect(projectGoal({ trendKg: 90, rate: losing, goalKg: 85, from })).toEqual({ kind: 'on-course', date: day('2027-01-06') });
    expect(projectGoal({ trendKg: 70, rate: { kind: 'rate', kgPerWeek: 0.25 }, goalKg: 71, from })).toEqual({ kind: 'on-course', date: day('2026-11-25') });
  });

  it('refuses to project from too little data', () => {
    expect(projectGoal({ trendKg: 90, rate: { kind: 'not-enough-data' }, goalKg: 85, from })).toEqual({ kind: 'not-enough-data' });
    expect(projectGoal({ trendKg: undefined, rate: { kind: 'not-enough-data' }, goalKg: 85, from })).toEqual({ kind: 'not-enough-data' });
  });

  it('names a reached goal, a flat trend, a trend moving away, and a missing goal', () => {
    expect(projectGoal({ trendKg: 85.2, rate: { kind: 'not-enough-data' }, goalKg: 85, from }).kind).toBe('reached');
    expect(projectGoal({ trendKg: 90, rate: { kind: 'rate', kgPerWeek: -0.01 }, goalKg: 85, from }).kind).toBe('steady');
    expect(projectGoal({ trendKg: 90, rate: { kind: 'rate', kgPerWeek: 0.3 }, goalKg: 85, from }).kind).toBe('away');
    expect(projectGoal({ trendKg: 90, rate: losing, goalKg: undefined, from }).kind).toBe('no-goal');
  });
});

describe('bodyWeightOn', () => {
  const me = profile(81);

  it('uses the trend from the first weigh-in on, and the profile weight before it', () => {
    const weighIns = [weighIn('2026-10-20', 90), weighIn('2026-10-21', 80)];
    expect(bodyWeightOn(weighIns, me, day('2026-10-19'))).toEqual({ kg: 81, source: 'profile' });
    expect(bodyWeightOn(weighIns, me, day('2026-10-20'))).toEqual({ kg: 90, source: 'trend' });
    expect(bodyWeightOn(weighIns, me, day('2026-10-28'))?.kg).toBeCloseTo(89);
  });

  it('knows nothing without a weigh-in or a profile', () => {
    expect(bodyWeightOn([], undefined, day('2026-10-28'))).toBeUndefined();
    expect(bodyWeightOn([weighIn('2026-10-29', 80)], undefined, day('2026-10-28'))).toBeUndefined();
  });
});
