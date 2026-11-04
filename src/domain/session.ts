import { z } from 'zod';
import { MET_ACTIVITIES, makeWorkout, metDraft, type Workout, type WorkoutDraft } from './burn.js';
import { LocalDate, Millis, ProgramId, SessionId, TrainingNoteId, WorkoutId } from './ids.js';
import { SetLog, SlotId, liftBook, liftIdOf, performanceId, type Lift, type LiftBook, type LiftId, type Performance, type Target, type Unit } from './lifts.js';
import { workingSets } from './progress.js';
import { BlockId, DayKey, stepsOf, type Block, type CardioBlock, type ChecklistBlock, type LiftsBlock, type PlannedDay, type Slot, type Step } from './program.js';

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
  /** Checklist blocks tapped Done, and cardio blocks passed over, so the card moves on. */
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

/** How long a session stays open after its last set, or its start before any set, until it counts as forgotten. */
export const OPEN_HOURS = 6;
const HOUR_MS = 3_600_000;

export type SessionPhase = 'open' | 'finished' | 'lapsed' | 'imported';

/** From the documents and the clock, so phone and coach agree with no stored flag. */
export function sessionPhase({ session, performances }: Pick<SessionLogs, 'session' | 'performances'>, now: Millis): SessionPhase {
  if (session.source === 'notion') return 'imported';
  if (session.finishedAt !== undefined) return 'finished';
  return Math.max(session.startedAt ?? 0, ...setTimes(performances)) + OPEN_HOURS * HOUR_MS > now ? 'open' : 'lapsed';
}

/** Neither finished nor imported, so the clock decides whether it is open or forgotten. */
export function isUnfinished(session: Session): boolean {
  return session.finishedAt === undefined && session.source !== 'notion';
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
export function roundsLogged(performances: readonly Performance[], slotId: SlotId): number {
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
      return logs.cardioDone || logs.session.checked?.includes(block.id) === true ? null : { kind: 'cardio', block };
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

/**
 * A tap on the plan. A slot shows its next round even past the prescription, which is how an extra
 * set is reached. A block shows its first gap and then hands back to nextUp.
 */
export type Focus = { readonly kind: 'slot'; readonly slotId: SlotId } | { readonly kind: 'block'; readonly blockId: BlockId };

function stepInSlot(day: PlannedDay, logs: SessionLogs, slotId: SlotId): Step | null {
  const block = liftsBlocks(day).find((b) => b.slots.some((slot) => slot.id === slotId));
  const slot = block?.slots.find((s) => s.id === slotId);
  if (block === undefined || slot === undefined) return null;
  const round = roundsLogged(logs.performances, slotId) + 1;
  const prescribed = stepsOf(block).find((s) => s.slot.id === slotId && s.round === round);
  return { block, slot, round, endsRound: prescribed?.endsRound ?? true };
}

/** What the card shows: where a tap on the plan points, else where the data says he is. A focus that no longer points at anything follows nextUp. */
export function cardFor(day: PlannedDay, logs: SessionLogs, focus: Focus | undefined): Next {
  if (focus?.kind === 'slot') {
    const step = stepInSlot(day, logs, focus.slotId);
    if (step !== null) return { kind: 'set', step };
  }
  if (focus?.kind === 'block') {
    const block = day.blocks.find((b) => b.id === focus.blockId);
    const gap = block === undefined ? null : firstGap(block, logs);
    if (gap !== null) return gap;
  }
  return nextUp(day, logs);
}

/** Past the prescription: a set the plan did not ask for. */
export function isExtra({ slot, round }: Step): boolean {
  return round > slot.target.sets;
}

/** Where the card goes after a set. nextUp never walks into an optional block, so one he jumped into keeps him until its gaps are filled. */
export function focusAfterSet({ block }: Step): Focus | undefined {
  return block.optional === true ? { kind: 'block', blockId: block.id } : undefined;
}

/** A checklist tapped Done, a cardio satisfied or passed over. */
export function blockDone(block: ChecklistBlock | CardioBlock, logs: SessionLogs): boolean {
  return firstGap(block, logs) === null;
}

/** One logged set and where it is stored, so a tap on its row can edit it. */
export interface LoggedSet {
  readonly performance: Performance;
  readonly index: number;
  readonly set: SetLog;
}

/** What the plan shows under a slot. */
export interface SlotLog {
  /** Working sets, which fill the dots. */
  readonly rounds: number;
  /** One per prescribed set, and one more per extra. */
  readonly dots: number;
  readonly skipped: boolean;
  /** Warm-ups too, across a swap, in the order tapped. */
  readonly sets: readonly LoggedSet[];
}

function setsInSlot(performances: readonly Performance[], slotId: SlotId): readonly LoggedSet[] {
  return performances
    .filter((p) => p.slotId === slotId)
    .flatMap((performance) => performance.sets.map((set, index) => ({ performance, index, set })))
    .toSorted((a, b) => (a.set.at ?? 0) - (b.set.at ?? 0));
}

export function slotLog(slot: Slot, { session, performances }: Pick<SessionLogs, 'session' | 'performances'>): SlotLog {
  const rounds = roundsLogged(performances, slot.id);
  return { rounds, dots: Math.max(slot.target.sets, rounds), skipped: skippedSlots(session).has(slot.id), sets: setsInSlot(performances, slot.id) };
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

function blankLoad(target: Target | undefined, unit: Unit): SetDraft['load'] {
  switch (target?.load) {
    case 'bodyweight':
      return { kind: 'bodyweight' };
    case 'band':
      return { kind: 'band', label: '' };
    case 'weight':
    case undefined:
      return { kind: 'weight', amount: null, unit };
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
 * when the caller hands over the slot's whole session. Warm-ups neither fill nor count, though a
 * blank load keeps the unit he warmed up in.
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
  const setsToday = input.today
    .filter((p) => members.has(p.liftId))
    .flatMap((p) => p.sets)
    .toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const doneToday = workingSets(setsToday);
  const newestLoad = setsToday.at(-1)?.load;
  const lastSets = input.last !== undefined && members.has(input.last.liftId) ? workingSets(input.last.sets) : [];
  const atPosition = lastSets[doneToday.length];
  const loadFrom = doneToday.at(-1) ?? atPosition ?? lastSets.at(-1);
  return {
    load: loadFrom?.load ?? blankLoad(input.target, newestLoad?.kind === 'weight' ? newestLoad.unit : 'lb'),
    reps: atPosition?.reps ?? bottomOfRange(input.target),
  };
}

/** What the card holds at the tap. */
export interface SetEntry extends SetDraft {
  readonly warmup: boolean;
  readonly note: string;
}

/** A logged set as the card reads it, to edit it. */
export function entryOfSet(set: SetLog): SetEntry {
  return { load: set.load, reps: set.reps, warmup: set.warmup === true, note: set.note ?? '' };
}

/** The set to store, or null while a number is blank or out of range, which keeps Log set off. */
export function setLogOf(entry: SetEntry, at?: Millis): SetLog | null {
  const note = entry.note.trim();
  const parsed = SetLog.safeParse({ load: entry.load, reps: entry.reps, ...(entry.warmup ? { warmup: true } : {}), ...(note === '' ? {} : { note }), ...(at === undefined ? {} : { at }) });
  return parsed.success ? parsed.data : null;
}

export const LOAD_STEP: Readonly<Record<Unit, number>> = { lb: 2.5, kg: 1 };

/** The − and + on a load. A load is positive, so − stops at one step, and a blank stays blank. */
export function steppedLoad(amount: number | null, unit: Unit, direction: 1 | -1): number | null {
  const step = LOAD_STEP[unit];
  if (amount === null) return direction === 1 ? step : null;
  return Math.max(step, amount + direction * step);
}

/** The − and + on reps. Zero is a real answer: he tried and got none. */
export function steppedReps(reps: number | null, direction: 1 | -1): number {
  return Math.max(0, (reps ?? 0) + direction);
}

export type Side = 'left' | 'right';

/** The order of the two rows on a per-side set. */
export function sideOrder(perSide: Target['perSide']): readonly [Side, Side] {
  return perSide === 'right-first' ? ['right', 'left'] : ['left', 'right'];
}

/** The lift a set logs under. */
export interface LiftChoice {
  readonly liftId: LiftId;
  readonly label: string;
}

/**
 * The lift he is doing in this slot now: whatever took its newest set, because a swap lasts until
 * he swaps back, else what the plan names.
 */
export function liftInSlot(slot: Slot, performances: readonly Performance[]): LiftChoice {
  const newest = setsInSlot(performances, slot.id).at(-1)?.performance;
  return newest === undefined || newest.liftId === slot.liftId ? { liftId: slot.liftId, label: slot.label } : { liftId: newest.liftId, label: newest.label };
}

/** The cue on the card. A listed swap's replaces the slot's, and any other lift has none. */
export function cueFor(slot: Slot, liftId: LiftId): string | undefined {
  return liftId === slot.liftId ? slot.cue : slot.swaps?.find((swap) => swap.liftId === liftId)?.cue;
}

/** Where a set goes, in the plan and in the lifts. */
export interface SetPlace {
  readonly session: Pick<Session, 'id' | 'date'>;
  readonly slot: Slot;
  readonly lift: LiftChoice;
}

export function performanceIdOf({ session, slot, lift }: SetPlace) {
  return performanceId(session.id, slot.id, lift.liftId);
}

/** The exercise with one more set. A lift other than the slot's makes a new performance marked as a swap, leaving sets already logged where they are. */
export function withSet(place: SetPlace, before: Performance | undefined, set: SetLog): Performance {
  if (before !== undefined) return { ...before, sets: [...before.sets, set] };
  const { session, slot, lift } = place;
  return {
    id: performanceIdOf(place),
    sessionId: session.id,
    date: session.date,
    liftId: lift.liftId,
    label: lift.label,
    slotId: slot.id,
    target: slot.target,
    sets: [set],
    ...(lift.liftId === slot.liftId ? {} : { plannedLiftId: slot.liftId }),
  };
}

/** The exercise with one set replaced, or removed when `set` is null. Null when that was the last, since a performance is the proof of at least one set. */
export function withEditedSet(before: Performance, index: number, set: SetLog | null): Performance | null {
  const sets = set === null ? before.sets.filter((_, i) => i !== index) : before.sets.map((old, i) => (i === index ? set : old));
  return sets.length === 0 ? null : { ...before, sets };
}

export function withSkip(session: Session, slotId: SlotId, note: string): Session {
  const trimmed = note.trim();
  const others = (session.skips ?? []).filter((skip) => skip.slotId !== slotId);
  return { ...session, skips: [...others, { slotId, ...(trimmed === '' ? {} : { note: trimmed }) }] };
}

/** He came back to a slot he skipped, so it is no longer a skip. */
export function withoutSkip(session: Session, slotId: SlotId): Session {
  const { skips, ...rest } = session;
  const others = (skips ?? []).filter((skip) => skip.slotId !== slotId);
  return others.length === 0 ? rest : { ...rest, skips: others };
}

export function withChecked(session: Session, blockId: BlockId): Session {
  return { ...session, checked: [...new Set([...(session.checked ?? []), blockId])] };
}

const MAX_LABEL = 80;

export interface SwapChoices {
  /** The plan's own lift when he has left it, then the slot's listed swaps. */
  readonly listed: readonly LiftChoice[];
  /** Catalog lifts matching the search. Empty with no search. */
  readonly catalog: readonly LiftChoice[];
  /** The search as a new lift, when it slugs and the catalog does not know it. */
  readonly typed: LiftChoice | null;
}

/** A swap's three sources, in the order the sheet offers them, without repeating a lift or offering the one he is on. */
export function swapChoices(input: { readonly slot: Slot; readonly lifts: readonly Lift[]; readonly current: LiftId; readonly query: string }): SwapChoices {
  const { slot, lifts, current } = input;
  const book = liftBook(lifts);
  const query = input.query.trim();
  const needle = query.toLowerCase();
  const slug = liftIdOf(query);
  const onlyOnce = new Set<LiftId>([book.canonical(current)]);
  const fresh = (choice: LiftChoice) => {
    const id = book.canonical(choice.liftId);
    if (onlyOnce.has(id)) return false;
    onlyOnce.add(id);
    return true;
  };
  const listed = [{ liftId: slot.liftId, label: slot.label }, ...(slot.swaps ?? []).map(({ liftId, label }) => ({ liftId, label }))].filter(fresh);
  const matching = query === '' ? [] : lifts.filter((lift) => lift.name.toLowerCase().includes(needle) || (slug !== null && (lift.id === slug || lift.aliases.includes(slug))));
  const catalog = matching.map((lift) => ({ liftId: lift.id, label: lift.name })).filter(fresh);
  const typed = slug === null || book.has(slug) || onlyOnce.has(slug) ? null : { liftId: slug, label: query.slice(0, MAX_LABEL) };
  return { listed, catalog, typed };
}

/** Nothing happened: no set, tick, skip, note or cardio. A session like this was a mistaken Start, so it does not count, and finishing or settling it leaves no trace. */
export function leftEmpty({ session, performances, cardioDone }: SessionLogs): boolean {
  return performances.length === 0 && !cardioDone && (session.skips ?? []).length === 0 && (session.checked ?? []).length === 0 && session.note === undefined;
}

const MAX_WORKOUT_MINUTES = 1440;

function setTimes(performances: readonly Performance[]): readonly Millis[] {
  return performances.flatMap((p) => p.sets.flatMap((set) => set.at ?? []));
}

/**
 * When a session ended. A session never finished ends at its last set's time once it lapses.
 * Null while it is open, and for a lapsed session with no timed set.
 */
export function finishOf(logs: Pick<SessionLogs, 'session' | 'performances'>, now: Millis): Millis | null {
  if (logs.session.finishedAt !== undefined) return logs.session.finishedAt;
  if (sessionPhase(logs, now) !== 'lapsed') return null;
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
  const minutes = Math.min(MAX_WORKOUT_MINUTES, Math.max(1, Math.round((input.finishedAt - firstAt) / 60_000 - cardio)));
  return { ...metDraft('strength', minutes), name: session.day?.label ?? MET_ACTIVITIES.strength.label };
}

export type DiaryResult = 'added' | 'no-sets' | 'no-weight';

export interface FinishDocs {
  readonly session: Session;
  /** Null when there is nothing to put in the diary, which `diary` says why. */
  readonly workout: Workout | null;
  readonly diary: DiaryResult;
}

/** What finishing writes, in one commit. The workout shares the session's id, so finishing twice converges. A session with no timed set writes none. */
export function finishDocs(input: { readonly logs: Pick<SessionLogs, 'session' | 'performances'>; readonly finishedAt: Millis; readonly others: readonly Workout[]; readonly kg: number | undefined }): FinishDocs {
  const { logs, finishedAt, kg } = input;
  const session = { ...logs.session, finishedAt };
  const draft = sessionWorkoutDraft(input);
  if (draft === null) return { session, workout: null, diary: 'no-sets' };
  if (kg === undefined) return { session, workout: null, diary: 'no-weight' };
  return { session, workout: makeWorkout(draft, { id: sessionWorkoutId(logs.session), date: logs.session.date, kg, loggedAt: finishedAt }), diary: 'added' };
}
