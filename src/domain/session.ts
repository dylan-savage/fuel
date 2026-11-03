import { z } from 'zod';
import { MET_ACTIVITIES, metDraft, type Workout, type WorkoutDraft } from './burn.js';
import { LocalDate, Millis, ProgramId, SessionId, TrainingNoteId, WorkoutId } from './ids.js';
import { SlotId, type LiftBook, type LiftId, type Performance, type SetLog, type Target, type Unit } from './lifts.js';
import { workingSets } from './progress.js';
import { BlockId, DayKey, stepsOf, type Block, type CardioBlock, type ChecklistBlock, type LiftsBlock, type PlannedDay, type Step } from './program.js';

/**
 * A session is thin: which day, which pinned version, when, plus the taps that have no sets to
 * live on. Sets live on performances. Position and rest are derived, so a reload or a lock has
 * no state to lose.
 */
export const Session = z.looseObject({
  id: SessionId,
  date: LocalDate,
  /** By value, so an old session names itself after its day leaves the program. Absent when he trained off plan. */
  day: z.looseObject({ key: DayKey, label: z.string().min(1).max(40) }).optional(),
  /** The version this session runs. Absent off plan and on imports. */
  programId: ProgramId.optional(),
  startedAt: Millis.optional(),
  finishedAt: Millis.optional(),
  skips: z.array(z.looseObject({ slotId: SlotId, note: z.string().max(1000).optional() })).optional(),
  /** Checklist blocks tapped Done. */
  checked: z.array(BlockId).optional(),
  note: z.string().max(2000).optional(),
  source: z.literal('notion').optional(),
});
export type Session = z.infer<typeof Session>;

/** A loose line to the coach with no session under it. Written only by the phone. */
export const TrainingNote = z.looseObject({
  id: TrainingNoteId,
  date: LocalDate,
  text: z.string().min(1).max(2000),
  at: Millis,
});
export type TrainingNote = z.infer<typeof TrainingNote>;

/** How long a session stays open after its start before it counts as forgotten. */
export const OPEN_HOURS = 6;
const HOUR_MS = 3_600_000;

export type SessionPhase = 'open' | 'finished' | 'lapsed' | 'imported';

/** From the document and the clock, so phone and coach agree with no stored flag. */
export function sessionPhase(session: Session, now: Millis): SessionPhase {
  if (session.source === 'notion') return 'imported';
  if (session.finishedAt !== undefined) return 'finished';
  return (session.startedAt ?? 0) + OPEN_HOURS * HOUR_MS > now ? 'open' : 'lapsed';
}

export interface SessionLogs {
  readonly session: Session;
  readonly performances: readonly Performance[];
  /** A workout other than this session's own is on its date. See cardioDoneOn. */
  readonly cardioDone: boolean;
}

/** The workout a session finishes into, which shares its id so finishing twice converges. */
export function sessionWorkoutId(session: Session): WorkoutId {
  return WorkoutId.parse(session.id);
}

/** A cardio logged from the Diary that morning satisfies the block too. */
export function cardioDoneOn(session: Session, workouts: readonly Workout[]): boolean {
  const own = sessionWorkoutId(session);
  return workouts.some((workout) => workout.date === session.date && workout.id !== own);
}

/** Sets across a swap count together, because a swap keeps the slot's id. Warm-ups never count as rounds. */
function roundsLogged(performances: readonly Performance[], slotId: SlotId): number {
  return performances.filter((p) => p.slotId === slotId).reduce((sum, p) => sum + workingSets(p.sets).length, 0);
}

function skippedSlots(session: Session): ReadonlySet<SlotId> {
  return new Set((session.skips ?? []).map((skip) => skip.slotId));
}

export type Next =
  | { readonly kind: 'set'; readonly step: Step }
  | { readonly kind: 'checklist'; readonly block: ChecklistBlock }
  | { readonly kind: 'cardio'; readonly block: CardioBlock }
  /** Required work is done. Optional blocks stay on screen but are not walked into. */
  | { readonly kind: 'done'; readonly optionalLeft: readonly Block[] };

function firstGap(block: Block, logs: SessionLogs): Exclude<Next, { kind: 'done' }> | null {
  switch (block.kind) {
    case 'lifts': {
      const skipped = skippedSlots(logs.session);
      const step = stepsOf(block).find((s) => !skipped.has(s.slot.id) && s.round > roundsLogged(logs.performances, s.slot.id));
      return step === undefined ? null : { kind: 'set', step };
    }
    case 'checklist':
      return logs.session.checked?.includes(block.id) === true ? null : { kind: 'checklist', block };
    case 'cardio':
      return logs.cardioDone ? null : { kind: 'cardio', block };
  }
}

/**
 * Where he is, read from the data: the first step with no set under it. A skipped slot is
 * passed over, and logging out of order just moves the first gap.
 */
export function nextUp(day: PlannedDay, logs: SessionLogs): Next {
  const optionalLeft: Block[] = [];
  for (const block of day.blocks) {
    const gap = firstGap(block, logs);
    if (gap === null) continue;
    if (block.optional !== true) return gap;
    optionalLeft.push(block);
  }
  return { kind: 'done', optionalLeft };
}

export interface RestClock {
  readonly endsAt: Millis;
  readonly seconds: number;
}

/** The newest timed set, with the performance holding it. Imported sets have no time and never reach it. */
function newestSet(performances: readonly Performance[]): { readonly performance: Performance; readonly set: SetLog; readonly at: Millis } | null {
  let newest: { readonly performance: Performance; readonly set: SetLog; readonly at: Millis } | null = null;
  for (const performance of performances) {
    for (const set of performance.sets) {
      if (set.at !== undefined && (newest === null || set.at >= newest.at)) newest = { performance, set, at: set.at };
    }
  }
  return newest;
}

function liftsBlocks(day: PlannedDay): readonly LiftsBlock[] {
  return day.blocks.filter((block) => block.kind === 'lifts');
}

/**
 * Clock arithmetic from the newest set's tap, so a lock or a reload cannot stop it. Null when
 * that set finished no round: a warm-up, or a superset with a slot still to do. It asks whether
 * the round is complete rather than which slot came last, so logging out of order and skipping
 * the last slot both still rest.
 */
export function restClock(day: PlannedDay, logs: SessionLogs): RestClock | null {
  const newest = newestSet(logs.performances);
  if (newest === null || newest.set.warmup === true) return null;
  const { slotId } = newest.performance;
  const block = liftsBlocks(day).find((b) => b.slots.some((slot) => slot.id === slotId));
  if (slotId === undefined || block?.restSeconds === undefined) return null;
  const round = roundsLogged(logs.performances, slotId);
  const skipped = skippedSlots(logs.session);
  const complete = block.slots.every((slot) => slot.target.sets < round || skipped.has(slot.id) || roundsLogged(logs.performances, slot.id) >= round);
  return complete ? { endsAt: Millis.parse(newest.at + block.restSeconds * 1000), seconds: block.restSeconds } : null;
}

/** Set inputs before a tap. A number may be blank, which a prefill cannot always fill. */
export interface SetDraft {
  readonly load: { readonly kind: 'weight'; readonly amount: number | null; readonly unit: Unit } | { readonly kind: 'bodyweight' } | { readonly kind: 'band'; readonly label: string };
  readonly reps: { readonly kind: 'total'; readonly reps: number | null } | { readonly kind: 'sides'; readonly left: number | null; readonly right: number | null };
}

function blankLoad(target: Target | undefined): SetDraft['load'] {
  switch (target?.load) {
    case 'bodyweight':
      return { kind: 'bodyweight' };
    case 'band':
      return { kind: 'band', label: '' };
    case 'weight':
    case undefined:
      return { kind: 'weight', amount: null, unit: 'lb' };
  }
}

function bottomOfRange(target: Target | undefined): SetDraft['reps'] {
  const reps = target?.reps.min ?? null;
  return target?.perSide === undefined ? { kind: 'total', reps } : { kind: 'sides', left: reps, right: reps };
}

/**
 * The next working set, for the lift he is doing now. Load: the previous working set of this
 * lift today, else last time's at this position, else last time's last, else blank. Reps: last
 * time's at this position, else the bottom of the range. A lift logged in kg comes back in kg.
 *
 * Everything is filtered to `lift`, so after a swap the old lift's weight cannot land here even
 * when the caller hands over the slot's whole session. Warm-ups neither fill nor count.
 */
export function prefillSet(input: {
  readonly lift: LiftId;
  readonly book: LiftBook;
  readonly target: Target | undefined;
  /** This session's performances. */
  readonly today: readonly Performance[];
  /** The lift's last performance before today, from lastTimeOf. */
  readonly last: Performance | undefined;
}): SetDraft {
  const members = new Set(input.book.members(input.lift));
  const doneToday = workingSets(input.today.filter((p) => members.has(p.liftId)).flatMap((p) => p.sets)).toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const lastSets = input.last !== undefined && members.has(input.last.liftId) ? workingSets(input.last.sets) : [];
  const atPosition = lastSets[doneToday.length];
  const loadFrom = doneToday.at(-1) ?? atPosition ?? lastSets.at(-1);
  return {
    load: loadFrom?.load ?? blankLoad(input.target),
    reps: atPosition?.reps ?? bottomOfRange(input.target),
  };
}

function setTimes(performances: readonly Performance[]): readonly Millis[] {
  return performances.flatMap((p) => p.sets.flatMap((set) => set.at ?? []));
}

/**
 * When a session ended. A session never finished ends at its last set's time once it lapses.
 * Null while it is open, and for a lapsed session with no timed set.
 */
export function finishOf(logs: Pick<SessionLogs, 'session' | 'performances'>, now: Millis): Millis | null {
  if (logs.session.finishedAt !== undefined) return logs.session.finishedAt;
  if (sessionPhase(logs.session, now) !== 'lapsed') return null;
  const times = setTimes(logs.performances);
  return times.length === 0 ? null : Millis.parse(Math.max(...times));
}

/**
 * The lifting half of the session's workout, or null with no timed set, as on a cardio-only day
 * or an import. Minutes run from the first set, warm-ups included, to the finish, less any
 * cardio logged inside that span, so burn is not counted twice. Its own earlier workout is left
 * out, so finishing twice gives the same answer.
 */
export function sessionWorkoutDraft(input: { readonly logs: Pick<SessionLogs, 'session' | 'performances'>; readonly finishedAt: Millis; readonly others: readonly Workout[] }): WorkoutDraft | null {
  const { session, performances } = input.logs;
  const times = setTimes(performances);
  if (times.length === 0) return null;
  const firstAt = Math.min(...times);
  const own = sessionWorkoutId(session);
  const cardio = input.others.filter((w) => w.id !== own && w.loggedAt >= firstAt && w.loggedAt <= input.finishedAt).reduce((sum, w) => sum + w.minutes, 0);
  const minutes = Math.max(1, Math.round((input.finishedAt - firstAt) / 60_000 - cardio));
  return { ...metDraft('strength', minutes), name: session.day?.label ?? MET_ACTIVITIES.strength.label };
}
