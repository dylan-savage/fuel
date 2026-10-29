import { z } from 'zod';
import { todo } from '../todo.js';
import { ExerciseId, HealthDayId, LocalDate, Millis } from './ids.js';
import { Kcal, Kg } from './units.js';

/**
 * MET values for manual workouts. Seeded from the Compendium of Physical Activities;
 * verify each value before relying on it. Adding an activity is one line here.
 */
export const MET_ACTIVITIES = {
  walking_brisk: { label: 'Walking, brisk', met: 4.3 },
  running_10min_mile: { label: 'Running, 10 min/mile', met: 9.8 },
  cycling_moderate: { label: 'Cycling, moderate', met: 8.0 },
  weights_general: { label: 'Weight training', met: 3.5 },
  weights_vigorous: { label: 'Weight training, vigorous', met: 6.0 },
  hiit: { label: 'HIIT / circuit', met: 8.0 },
  yoga: { label: 'Yoga', met: 2.5 },
} as const;
export type MetActivityId = keyof typeof MET_ACTIVITIES;
const MetActivityId = z.custom<MetActivityId>((v) => typeof v === 'string' && v in MET_ACTIVITIES);

/**
 * A manually logged workout. kcal is computed once at log time from the trend weight then,
 * and stored, so later weight changes do not rewrite past burn. Synced doc kind 'exercise'.
 */
export const Exercise = z.object({
  id: ExerciseId,
  date: LocalDate,
  label: z.string().min(1),
  minutes: z.number().positive().max(600),
  kcal: Kcal,
  basis: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('met'), activity: MetActivityId, met: z.number().positive(), kgUsed: Kg }),
    z.object({ kind: z.literal('entered') }),
  ]),
  at: Millis,
});
export type Exercise = z.infer<typeof Exercise>;

/** kcal = MET x body kg x hours. */
export function metKcal(met: number, kg: Kg, minutes: number): Kcal {
  return todo(`metKcal(${met}, ${kg}, ${minutes})`);
}

export const HealthMetric = z.enum(['active_kcal', 'steps', 'weight_kg']);
export type HealthMetric = z.infer<typeof HealthMetric>;

/** One cumulative Health reading and the moment the Shortcut read it. */
export const Reading = z.object({ value: z.number().nonnegative(), asOf: Millis });
export type Reading = z.infer<typeof Reading>;

/**
 * Apple Health totals for one diary day. Written only by the server's ingest route
 * (kind writer 'server'); the phone reads it and can never push it.
 */
export const HealthDay = z.object({
  id: HealthDayId,
  date: LocalDate,
  metrics: z.partialRecord(HealthMetric, Reading),
});
export type HealthDay = z.infer<typeof HealthDay>;

/**
 * Per metric, the reading with the later asOf wins (ties keep the current one).
 * Commutative, associative and idempotent: resent payloads, overlapping runs and
 * out-of-order delivery all converge to the same document.
 */
export function mergeHealthDay(current: HealthDay | null, incoming: HealthDay): HealthDay {
  return todo(`mergeHealthDay(${current?.id ?? 'null'}, ${incoming.id})`);
}

export interface DayBurn {
  readonly kcal: Kcal;
  readonly basis: 'health' | 'manual' | 'none';
}

/**
 * Burn for a day = max(Health active energy, sum of manual workouts). Never the sum of
 * both: a workout the Watch saw is already inside active energy, so adding it would
 * double count. The max under-counts only when manual and tracked burn are disjoint,
 * which is the safe direction for a deficit.
 */
export function dayBurn(exercise: readonly Exercise[], health: HealthDay | null): DayBurn {
  return todo(`dayBurn(${exercise.length}, ${health?.id ?? 'null'})`);
}
