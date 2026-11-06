import { z } from 'zod';
import { MET_ACTIVITIES, makeWorkout, metDraft, type Workout, type WorkoutDraft } from './burn.js';
import { LocalDate, Millis, ProgramId, SessionId, TrainingNoteId, WorkoutId } from './ids.js';
import { SetLog, SlotId, liftBook, liftIdOf, performanceId, type Lift, type LiftBook, type LiftId, type Performance, type Target, type Unit } from './lifts.js';
import { workingSets } from './progress.js';
import { BlockId, DayKey, type CardioBlock, type ChecklistBlock, type PlannedDay, type Slot } from './program.js';

/**
 * A session is thin: which day, which pinned version, when, plus the taps that have no sets to
 * live on. Sets live on performances. Nothing on screen names one. The first write for a day on a
 * date makes it, and it finishes by itself, so history, the coach and the diary have it to read.
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
  /** Blocks tapped Done. */
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
export function sessionPhase({ session, performances }: SessionLogs, now: Millis): SessionPhase {
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
}

/** One planned day on one date, which is where a write lands. */
export interface DayRef {
  readonly key: DayKey;
  readonly date: LocalDate;
}

/** The session a day's writes land on, from that date's sessions. An import is history and takes none. Two are only possible from two phones or an older build, and the newest wins. */
export function sessionForDay(sessions: readonly Session[], key: DayKey): Session | undefined {
  return sessions
    .filter((session) => session.day?.key === key && session.source !== 'notion')
    .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .at(-1);
}

/** What a day holds on a date. No session until the first write. */
export interface DayLogs {
  readonly session: Session | null;
  readonly performances: readonly Performance[];
  /** A workout other than this session's own is on the date. See cardioDoneOn. */
  readonly cardioDone: boolean;
}

/** The workout a session finishes into, which shares its id so finishing twice converges. */
export function sessionWorkoutId(session: Session): WorkoutId {
  return WorkoutId.parse(session.id);
}

/** Of that date's workouts. A cardio logged from the Diary that morning satisfies the block too. */
export function cardioDoneOn(session: Session | null, workouts: readonly Workout[]): boolean {
  const own = session === null ? null : sessionWorkoutId(session);
  return workouts.some((workout) => workout.id !== own);
}

/** A checklist tapped Done, or a cardio logged. */
export function blockDone(block: ChecklistBlock | CardioBlock, { session, cardioDone }: Pick<DayLogs, 'session' | 'cardioDone'>): boolean {
  return session?.checked?.includes(block.id) === true || (block.kind === 'cardio' && cardioDone);
}

/** One logged set and where it is stored, so a tap on its value can edit it. */
export interface LoggedSet {
  readonly performance: Performance;
  readonly index: number;
  readonly set: SetLog;
}

/**
 * An exercise on a day as he is doing it now: a slot with whatever lift is in it, or a lift he
 * added on the spot, which has no slot and is only its lift. Mirrors Performance's optional slotId.
 */
export interface Exercise {
  readonly slot: Slot | null;
  readonly lift: LiftChoice;
}

/** A planned exercise holds every row in its slot, across a swap. An added one holds only slot-less rows of its own lift, so a swap into a slot never lands on it. */
export function isOn(exercise: Exercise, row: { readonly slotId?: SlotId | undefined; readonly liftId: LiftId }): boolean {
  return exercise.slot === null ? row.slotId === undefined && row.liftId === exercise.lift.liftId : row.slotId === exercise.slot.id;
}

/** What today holds of one exercise. */
export interface ExerciseLog {
  /** Working sets, which fill the dots. The next set is one past these. */
  readonly done: number;
  /** One per prescribed set, and one more per extra. An added exercise prescribes none, so it has one per working set. */
  readonly dots: number;
  /** An added exercise is never skipped. */
  readonly skipped: boolean;
  /** Warm-ups too, across a swap, in the order tapped. */
  readonly sets: readonly LoggedSet[];
}

export function exerciseLog(exercise: Exercise, { session, performances }: Pick<DayLogs, 'session' | 'performances'>): ExerciseLog {
  const sets = performances
    .filter((p) => isOn(exercise, p))
    .flatMap((performance) => performance.sets.map((set, index) => ({ performance, index, set })))
    .toSorted((a, b) => (a.set.at ?? 0) - (b.set.at ?? 0));
  const done = workingSets(sets.map((row) => row.set)).length;
  const { slot } = exercise;
  if (slot === null) return { done, dots: done, skipped: false, sets };
  return { done, dots: Math.max(slot.target.sets, done), skipped: session?.skips?.some((skip) => skip.slotId === slot.id) === true, sets };
}

/** The exercises he added that day, in the order he started them. Derived from performances, so there is no list to keep. */
export function addedOn(performances: readonly Performance[]): readonly LiftChoice[] {
  const startOf = (p: Performance) => Math.min(...p.sets.map((set) => set.at ?? 0));
  return performances
    .filter((p) => p.slotId === undefined)
    .toSorted((a, b) => startOf(a) - startOf(b))
    .map((p) => ({ liftId: p.liftId, label: p.label }));
}

/** Every lift the day already holds: each slot's planned lift and the one in it now, and what he added. The add picker leaves these out. */
export function liftsOnDay(plan: PlannedDay, added: readonly LiftChoice[], liftOf: (slot: Slot) => LiftChoice): readonly LiftId[] {
  const slots = plan.blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots : []));
  return [...new Set([...slots.flatMap((slot) => [slot.liftId, liftOf(slot).liftId]), ...added.map((lift) => lift.liftId)])];
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
 * time's at this position, else the set before it today, else the bottom of the range. A lift logged in kg comes back in kg.
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
    reps: atPosition?.reps ?? doneToday.at(-1)?.reps ?? bottomOfRange(input.target),
  };
}

/** What the exercise holds at the tap. */
export interface SetEntry extends SetDraft {
  readonly warmup: boolean;
  readonly note: string;
}

/** A logged set as the exercise reads it, to edit it. */
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

/** The − and + on a load. A load is positive, so − past the last step is bodyweight, as on a dumbbell lift done without one. */
export function steppedLoad(amount: number | null, unit: Unit, direction: 1 | -1): number | 'bodyweight' {
  const next = (amount ?? 0) + direction * LOAD_STEP[unit];
  return next > 0 ? next : 'bodyweight';
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
  const planned = { liftId: slot.liftId, label: slot.label };
  const newest = exerciseLog({ slot, lift: planned }, { session: null, performances }).sets.at(-1)?.performance;
  return newest === undefined || newest.liftId === slot.liftId ? planned : { liftId: newest.liftId, label: newest.label };
}

/** The cue on the exercise. A listed swap's replaces the slot's, and any other lift has none. */
export function cueFor(slot: Slot, liftId: LiftId): string | undefined {
  return liftId === slot.liftId ? slot.cue : slot.swaps?.find((swap) => swap.liftId === liftId)?.cue;
}

/** Where a set goes. */
export interface SetPlace {
  readonly session: Pick<Session, 'id' | 'date'>;
  readonly exercise: Exercise;
}

export function performanceIdOf({ session, exercise }: SetPlace) {
  return performanceId(session.id, exercise.slot?.id, exercise.lift.liftId);
}

/**
 * The exercise with one more set. A first set makes the performance. A planned one carries its
 * slot and target, and a lift other than the slot's is marked as a swap, leaving sets already
 * logged where they are. An added one carries none of them.
 */
export function withSet(place: SetPlace, before: Performance | undefined, set: SetLog): Performance {
  if (before !== undefined) return { ...before, sets: [...before.sets, set] };
  const {
    session,
    exercise: { slot, lift },
  } = place;
  return {
    id: performanceIdOf(place),
    sessionId: session.id,
    date: session.date,
    liftId: lift.liftId,
    label: lift.label,
    ...(slot === null ? {} : { slotId: slot.id, target: slot.target }),
    sets: [set],
    ...(slot === null || lift.liftId === slot.liftId ? {} : { plannedLiftId: slot.liftId }),
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

/** Back to being derived, so the session's workout catches up at the next settle. */
export function reopened(session: Session): Session {
  const { finishedAt: _finishedAt, ...rest } = session;
  return rest;
}

/**
 * What a set does to its session: it takes back a skip of that slot and reopens a settled one. A
 * set on an added exercise has no skip to take back. The same session when neither applies, so a
 * set usually writes one document.
 */
export function afterSet(session: Session, slotId: SlotId | undefined): Session {
  const skipped = slotId !== undefined && session.skips?.some((skip) => skip.slotId === slotId) === true;
  if (!skipped && session.finishedAt === undefined) return session;
  return reopened(slotId === undefined ? session : withoutSkip(session, slotId));
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

/** Nothing in it: no set, tick, skip or note, as after deleting its only set. It does not count, and settling it leaves no trace. */
export function leftEmpty({ session, performances }: SessionLogs): boolean {
  return performances.length === 0 && (session.skips ?? []).length === 0 && (session.checked ?? []).length === 0 && session.note === undefined;
}

const MAX_WORKOUT_MINUTES = 1440;

function setTimes(performances: readonly Performance[]): readonly Millis[] {
  return performances.flatMap((p) => p.sets.flatMap((set) => set.at ?? []));
}

const RESUME_HOURS = 3;

/** A set this recent means he is still training, so a relaunch starts on Train. */
export function trainedLately(performances: readonly Performance[], now: Millis): boolean {
  return setTimes(performances).some((at) => at > now - RESUME_HOURS * HOUR_MS);
}

/**
 * When a session ended. A session never finished ends at its last set's time once it lapses.
 * Null while it is open, and for a lapsed session with no timed set.
 */
export function finishOf(logs: SessionLogs, now: Millis): Millis | null {
  if (logs.session.finishedAt !== undefined) return logs.session.finishedAt;
  if (sessionPhase(logs, now) !== 'lapsed') return null;
  const times = setTimes(logs.performances);
  return times.length === 0 ? null : Millis.parse(Math.max(...times));
}

/**
 * The lifting half of the session's workout, or null with no timed set, as on a cardio-only day
 * or an import. Minutes run from the first set, warm-ups included, to the finish, less any
 * cardio logged inside that span, so burn is not counted twice. Its own earlier workout is left
 * out, so settling twice gives the same answer.
 */
export function sessionWorkoutDraft(input: { readonly logs: SessionLogs; readonly finishedAt: Millis; readonly others: readonly Workout[] }): WorkoutDraft | null {
  const { session, performances } = input.logs;
  const times = setTimes(performances);
  if (times.length === 0) return null;
  const firstAt = Math.min(...times);
  const own = sessionWorkoutId(session);
  const cardio = input.others.filter((w) => w.id !== own && w.loggedAt >= firstAt && w.loggedAt <= input.finishedAt).reduce((sum, w) => sum + w.minutes, 0);
  const minutes = Math.min(MAX_WORKOUT_MINUTES, Math.max(1, Math.round((input.finishedAt - firstAt) / 60_000 - cardio)));
  return { ...metDraft('strength', minutes), name: session.day?.label ?? MET_ACTIVITIES.strength.label };
}

export interface FinishDocs {
  readonly session: Session;
  /** Null with no timed set or no known body weight. */
  readonly workout: Workout | null;
}

/** What settling writes, in one commit. The workout shares the session's id, so settling twice converges. */
export function finishDocs(input: { readonly logs: SessionLogs; readonly finishedAt: Millis; readonly others: readonly Workout[]; readonly kg: number | undefined }): FinishDocs {
  const { logs, finishedAt, kg } = input;
  const session = { ...logs.session, finishedAt };
  const draft = sessionWorkoutDraft(input);
  if (draft === null || kg === undefined) return { session, workout: null };
  return { session, workout: makeWorkout(draft, { id: sessionWorkoutId(logs.session), date: logs.session.date, kg, loggedAt: finishedAt }) };
}
