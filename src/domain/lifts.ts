import { z } from 'zod';
import { LocalDate, Millis, PerformanceId, SessionId } from './ids.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 60;

/**
 * A lift's identity is a slug of its name, so the phone can log a brand new name offline with
 * no catalog write, and typing the same name twice lands on the same history.
 */
export const LiftId = z.string().regex(SLUG).max(MAX_SLUG).brand<'LiftId'>();
export type LiftId = z.infer<typeof LiftId>;

export const SlotId = z.string().min(1).max(40).brand<'SlotId'>();
export type SlotId = z.infer<typeof SlotId>;

/**
 * "Seated row (wide grip)" and "Seated row (close grip)" are one lift, because parentheticals
 * are dropped. Null when a name has nothing left to slug.
 */
export function liftIdOf(name: string): LiftId | null {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, '');
  const parsed = LiftId.safeParse(slug);
  return parsed.success ? parsed.data : null;
}

/** A catalog row. `aliases` joins histories on read, so merging two lifts rewrites no performance. */
export const Lift = z.looseObject({
  id: LiftId,
  name: z.string().min(1).max(80),
  aliases: z.array(LiftId),
  /** Shown on the key-lift board. */
  key: z.boolean().optional(),
});
export type Lift = z.infer<typeof Lift>;

export interface LiftBook {
  /** The lift an id belongs to now, following its alias. An id with no catalog row is its own lift. */
  canonical(id: LiftId): LiftId;
  /** Every id whose history counts as this lift's. */
  members(id: LiftId): readonly LiftId[];
  nameOf(id: LiftId): string | undefined;
  /** In the catalog, as a lift or an alias. */
  has(id: LiftId): boolean;
}

/** One hop is enough, because checkPublish refuses an alias that chains. */
export function liftBook(lifts: readonly Lift[]): LiftBook {
  const owners = new Map<LiftId, Lift>();
  for (const lift of lifts) {
    for (const id of [lift.id, ...lift.aliases]) owners.set(id, lift);
  }
  return {
    canonical: (id) => owners.get(id)?.id ?? id,
    members: (id) => {
      const lift = owners.get(id);
      return lift === undefined ? [id] : [lift.id, ...lift.aliases];
    },
    nameOf: (id) => owners.get(id)?.name,
    has: (id) => owners.has(id),
  };
}

export const Unit = z.enum(['lb', 'kg']);
export type Unit = z.infer<typeof Unit>;

/**
 * The load as read off the stack. Stored as typed, departing from fuel's stored-in-kg rule for
 * body weight, because the number on the stack is the fact: a converted 17.64 lb cannot prefill
 * "8 kg" next time. lbOf is the only conversion, and it runs on read.
 */
export const Load = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('weight'), amount: z.number().positive().max(2000), unit: Unit }),
  z.looseObject({ kind: z.literal('bodyweight') }),
  z.looseObject({ kind: z.literal('band'), label: z.string().min(1).max(40) }),
]);
export type Load = z.infer<typeof Load>;

const repCount = z.number().int().nonnegative().max(500);

export const SetReps = z.discriminatedUnion('kind', [z.looseObject({ kind: z.literal('total'), reps: repCount }), z.looseObject({ kind: z.literal('sides'), left: repCount, right: repCount })]);
export type SetReps = z.infer<typeof SetReps>;

export const SetLog = z.looseObject({
  load: Load,
  reps: SetReps,
  /** Flagged by Dylan. Absent means a working set, which is how every imported set reads. */
  warmup: z.literal(true).optional(),
  /** An answer to the slot's setPrompt. */
  note: z.string().max(280).optional(),
  /** The tap. The rest timer reads it. Absent on imported sets, which never recorded one. */
  at: Millis.optional(),
});
export type SetLog = z.infer<typeof SetLog>;

/** A prescription. "2 x 10" is min = max = 10. A slot with fewer sets than its superset sits out the last rounds. */
export const Target = z.looseObject({
  sets: z.number().int().min(1).max(20),
  reps: z.looseObject({ min: repCount, max: repCount }).refine((r) => r.min <= r.max, 'reps.min is above reps.max'),
  /** Per arm or leg, naming the side he starts on, or 'either' when the plan names none. Absent means both together. */
  perSide: z.enum(['left-first', 'right-first', 'either']).optional(),
  /** What the set is loaded with. Absent means weight. */
  load: z.enum(['weight', 'bodyweight', 'band']).optional(),
});
export type Target = z.infer<typeof Target>;

/** An exercise added on the spot has no slot, which leaves that segment empty. A slot id is never empty, so the two cannot collide. */
export function performanceId(sessionId: SessionId, slotId: SlotId | undefined, liftId: LiftId): PerformanceId {
  return PerformanceId.parse(`pf:${sessionId}:${slotId ?? ''}:${liftId}`);
}

/**
 * One exercise done in one session, indexed by lift and date, so "last time" is one seek. It
 * carries its prescription by value, so one row answers the last-time line and the add-weight
 * hint, and a range the coach changes later does not rewrite the verdict.
 */
export const Performance = z
  .looseObject({
    id: PerformanceId,
    sessionId: SessionId,
    /** The session's date, copied so the lift index carries it. Never re-derived from a set's time. */
    date: LocalDate,
    /** What was really done. A swap logs here, under the lift he did. */
    liftId: LiftId,
    /** The name then, such as a variation's. */
    label: z.string().min(1).max(80),
    /** Where it sat in the plan. Absent for an exercise added on the spot. */
    slotId: SlotId.optional(),
    /** Present only on a swap. Rows without it stay out of the planned-lift index. */
    plannedLiftId: LiftId.optional(),
    target: Target.optional(),
    /** At least one: this document is the proof he did the exercise, so readers never filter out empties. */
    sets: z.array(SetLog).min(1),
    note: z.string().max(1000).optional(),
  })
  .refine((p) => p.id === performanceId(p.sessionId, p.slotId, p.liftId), 'a performance id is pf:<session>:<slot>:<lift>')
  .refine((p) => p.plannedLiftId !== p.liftId, 'plannedLiftId is set only on a swap');
export type Performance = z.infer<typeof Performance>;
