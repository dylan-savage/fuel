import { z } from 'zod';
import { BodyKg } from './body.js';
import { LocalDate, Millis, WorkoutId } from './ids.js';

export const ACTIVITY_GROUPS = ['Walking', 'Running', 'Cycling', 'Gym', 'Swimming', 'Mind and body', 'Sports'] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

interface MetActivity {
  readonly label: string;
  readonly group: ActivityGroup;
  /** Energy as a multiple of resting, from the 2011 Compendium of Physical Activities. */
  readonly met: number;
}

/** The built-in workouts. Adding one is one line; a workout stores its label and MET, so old ones never need this table. */
export const MET_ACTIVITIES = {
  walk_2_5: { label: 'Walking, 2.5 mph', group: 'Walking', met: 3.0 },
  walk_3: { label: 'Walking, 3 mph', group: 'Walking', met: 3.5 },
  walk_3_5: { label: 'Walking, 3.5 mph, brisk', group: 'Walking', met: 4.3 },
  walk_4: { label: 'Walking, 4 mph, very brisk', group: 'Walking', met: 5.0 },
  hike: { label: 'Hiking', group: 'Walking', met: 6.0 },
  run_5: { label: 'Running, 5 mph (12 min/mi)', group: 'Running', met: 8.3 },
  run_6: { label: 'Running, 6 mph (10 min/mi)', group: 'Running', met: 9.8 },
  run_7: { label: 'Running, 7 mph (8:34 min/mi)', group: 'Running', met: 11.0 },
  run_8: { label: 'Running, 8 mph (7:30 min/mi)', group: 'Running', met: 11.8 },
  run_10: { label: 'Running, 10 mph (6 min/mi)', group: 'Running', met: 14.5 },
  cycle_leisure: { label: 'Cycling, under 10 mph', group: 'Cycling', met: 4.0 },
  cycle_moderate: { label: 'Cycling, 12 to 14 mph', group: 'Cycling', met: 8.0 },
  cycle_fast: { label: 'Cycling, 14 to 16 mph', group: 'Cycling', met: 10.0 },
  cycle_stationary: { label: 'Stationary bike, moderate', group: 'Cycling', met: 6.8 },
  strength: { label: 'Strength training', group: 'Gym', met: 3.5 },
  strength_vigorous: { label: 'Strength training, vigorous', group: 'Gym', met: 6.0 },
  hiit: { label: 'HIIT or circuit training', group: 'Gym', met: 8.0 },
  elliptical: { label: 'Elliptical, moderate', group: 'Gym', met: 5.0 },
  rowing: { label: 'Rowing machine, moderate', group: 'Gym', met: 7.0 },
  stairs: { label: 'Stair climber', group: 'Gym', met: 9.0 },
  swim_moderate: { label: 'Swimming laps, moderate', group: 'Swimming', met: 5.8 },
  swim_vigorous: { label: 'Swimming laps, vigorous', group: 'Swimming', met: 9.8 },
  yoga: { label: 'Yoga', group: 'Mind and body', met: 2.5 },
  yoga_power: { label: 'Power yoga', group: 'Mind and body', met: 4.0 },
  pilates: { label: 'Pilates', group: 'Mind and body', met: 3.0 },
  basketball: { label: 'Basketball', group: 'Sports', met: 6.5 },
  soccer: { label: 'Soccer, casual', group: 'Sports', met: 7.0 },
  tennis: { label: 'Tennis', group: 'Sports', met: 7.3 },
  golf: { label: 'Golf, walking with clubs', group: 'Sports', met: 4.3 },
  climbing: { label: 'Rock climbing', group: 'Sports', met: 5.8 },
} as const satisfies Readonly<Record<string, MetActivity>>;
export type MetActivityId = keyof typeof MET_ACTIVITIES;

function isMetActivityId(value: string): value is MetActivityId {
  return Object.hasOwn(MET_ACTIVITIES, value);
}

export const MET_ACTIVITY_IDS: readonly MetActivityId[] = Object.keys(MET_ACTIVITIES).filter(isMetActivityId);

/**
 * How the burn was worked out. `activity` is a plain string, not this app's table, so a
 * workout a newer app logs from a newer table still parses here.
 */
export const WorkoutSource = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('met'), activity: z.string(), met: z.number().min(1).max(25) }),
  /** A burn Dylan typed in, as a machine or calculator reports it: resting burn included. */
  z.looseObject({ kind: z.literal('custom'), grossKcal: z.number().positive().max(10_000) }),
]);
export type WorkoutSource = z.infer<typeof WorkoutSource>;

/**
 * One workout. `kcal` is the burn above resting, fixed at log time from the body weight
 * then (`kg`), so later weigh-ins never rewrite past burn. Synced document kind 'workout'.
 */
export const Workout = z.looseObject({
  id: WorkoutId,
  date: LocalDate,
  name: z.string().min(1).max(80),
  minutes: z.number().positive().max(1440),
  source: WorkoutSource,
  kg: BodyKg,
  kcal: z.number().nonnegative().max(20_000),
  loggedAt: Millis,
});
export type Workout = z.infer<typeof Workout>;

/** What the workout logger edits: the rest comes from the day, the clock and the body weight. */
export const WorkoutDraft = Workout.pick({ name: true, minutes: true, source: true });
export type WorkoutDraft = z.infer<typeof WorkoutDraft>;

/** One MET is about one kcal per kg per hour: the burn BMR already counts. */
export function restingKcal(kg: number, minutes: number): number {
  return (kg * minutes) / 60;
}

/**
 * The burn above resting, which is what the budget may add without counting BMR twice.
 * MET workouts burn (MET − 1) × kg × hours; a typed-in burn loses the resting share.
 */
export function netKcal(draft: WorkoutDraft, kg: number): number {
  switch (draft.source.kind) {
    case 'met':
      return (draft.source.met - 1) * restingKcal(kg, draft.minutes);
    case 'custom':
      return Math.max(0, draft.source.grossKcal - restingKcal(kg, draft.minutes));
  }
}

export function metDraft(activity: MetActivityId, minutes: number): WorkoutDraft {
  const { label, met } = MET_ACTIVITIES[activity];
  return { name: label, minutes, source: { kind: 'met', activity, met } };
}

export function makeWorkout(draft: WorkoutDraft, at: { readonly id: WorkoutId; readonly date: LocalDate; readonly kg: number; readonly loggedAt: Millis }): Workout {
  return { ...draft, ...at, kcal: Math.round(netKcal(draft, at.kg)) };
}

export function draftOf(workout: Workout): WorkoutDraft {
  return { name: workout.name, minutes: workout.minutes, source: workout.source };
}

/** The day's burn above resting. */
export function workoutKcal(workouts: readonly Workout[]): number {
  return workouts.reduce((sum, w) => sum + w.kcal, 0);
}

const sameKind = (w: WorkoutDraft) => (w.source.kind === 'met' ? `met:${w.source.activity}` : `custom:${w.name.trim().toLowerCase()}`);

/** The last `limit` different workouts, newest first, each as it was last logged, to log again in a tap. */
export function recentWorkouts(workouts: readonly Workout[], limit: number): WorkoutDraft[] {
  const seen = new Map<string, WorkoutDraft>();
  for (const workout of workouts.toSorted((a, b) => b.loggedAt - a.loggedAt)) {
    const draft = draftOf(workout);
    if (!seen.has(sameKind(draft))) seen.set(sameKind(draft), draft);
  }
  return [...seen.values()].slice(0, limit);
}
