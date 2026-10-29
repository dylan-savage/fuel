import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MET_ACTIVITIES, makeWorkout, metDraft, netKcal, recentWorkouts, type WorkoutDraft } from '../src/domain/burn.js';
import { LocalDate, Millis, WorkoutId } from '../src/domain/ids.js';

const at = { date: LocalDate.parse('2026-10-28'), loggedAt: Millis.parse(1_800_000_000_000) };
const newId = () => WorkoutId.parse(randomUUID());
const custom = (name: string, minutes: number, grossKcal: number): WorkoutDraft => ({ name, minutes, source: { kind: 'custom', grossKcal } });

describe('net workout kcal', () => {
  it('is (MET − 1) × kg × hours, leaving out the resting burn BMR already counts', () => {
    // Running at 6 mph is 9.3 MET: 8.3 × 80 kg × 0.5 h.
    expect(netKcal(metDraft('run_6', 30), 80)).toBeCloseTo(332);
    // Strength training is 3.5 MET: 2.5 × 90 kg × 1 h.
    expect(netKcal(metDraft('strength', 60), 90)).toBeCloseTo(225);
  });

  it('takes the resting share off a typed-in burn, and never goes below zero', () => {
    expect(netKcal(custom('Spin class', 60, 300), 80)).toBeCloseTo(220);
    expect(netKcal(custom('Stretching', 60, 50), 80)).toBe(0);
  });

  it('is stored at log time with the weight it was worked out at', () => {
    const workout = makeWorkout(metDraft('run_6', 30), { ...at, id: newId(), kg: 80 });
    expect(workout).toMatchObject({ name: MET_ACTIVITIES.run_6.label, minutes: 30, kg: 80, kcal: 332, source: { kind: 'met', activity: 'run_6', met: 9.3 } });
  });
});

describe('recentWorkouts', () => {
  it('offers each kind of workout once, newest first, as last logged', () => {
    const log = (draft: WorkoutDraft, ms: number) => makeWorkout(draft, { ...at, id: newId(), kg: 80, loggedAt: Millis.parse(ms) });
    const workouts = [log(metDraft('run_6', 30), 1), log(metDraft('strength', 45), 2), log(metDraft('run_6', 40), 3), log(custom('Spin class', 45, 400), 4)];
    expect(recentWorkouts(workouts, 5).map((w) => [w.name, w.minutes])).toEqual([
      ['Spin class', 45],
      [MET_ACTIVITIES.run_6.label, 40],
      [MET_ACTIVITIES.strength.label, 45],
    ]);
    expect(recentWorkouts(workouts, 1)).toHaveLength(1);
  });
});
