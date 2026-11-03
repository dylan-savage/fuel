import { KG_PER_LB } from './goals.js';
import { addDays, mondayOf, type LocalDate, type SessionId } from './ids.js';
import type { LiftBook, LiftId, Load, Performance, SetLog, SetReps, SlotId } from './lifts.js';
import type { PlannedDay } from './program.js';
import type { Session, SessionPhase } from './session.js';

/** The only unit conversion. Null for bodyweight and bands: they have no pounds, and zero would be a lie on a chart. */
export function lbOf(load: Load): number | null {
  switch (load.kind) {
    case 'weight':
      return load.unit === 'lb' ? load.amount : load.amount / KG_PER_LB;
    case 'bodyweight':
    case 'band':
      return null;
  }
}

/** The sets that count. Every top weight, volume, est. 1RM and hint goes through this one filter. */
export function workingSets(sets: readonly SetLog[]): readonly SetLog[] {
  return sets.filter((set) => set.warmup !== true);
}

/** An estimate that runs high on long sets, so screens write "est." */
export function epley(lb: number, reps: number): number {
  return lb * (1 + reps / 30);
}

/** What a set counts as in Epley and on a reps-only chart. A per-side set reads its better side. */
export function repsRead(reps: SetReps): number {
  return reps.kind === 'total' ? reps.reps : Math.max(reps.left, reps.right);
}

/** What a set counts as against a range. A per-side set reads its weaker side, so both sides earn the added weight. */
function repsAgainstRange(reps: SetReps): number {
  return reps.kind === 'total' ? reps.reps : Math.min(reps.left, reps.right);
}

/** Work done, so a per-side set counts both sides. */
function repsDone(reps: SetReps): number {
  return reps.kind === 'total' ? reps.reps : reps.left + reps.right;
}

export interface ExerciseTotals {
  readonly topLb: number | null;
  readonly volumeLb: number | null;
  readonly e1rmLb: number | null;
}

/**
 * Over working sets, unrounded. Null with no weighted set, never 0. A set of no reps lifted
 * nothing, so it moves neither maximum.
 */
export function totalsOf(sets: readonly SetLog[]): ExerciseTotals {
  let topLb: number | null = null;
  let volumeLb: number | null = null;
  let e1rmLb: number | null = null;
  for (const set of workingSets(sets)) {
    const lb = lbOf(set.load);
    const reps = repsRead(set.reps);
    if (lb === null || reps === 0) continue;
    topLb = Math.max(topLb ?? 0, lb);
    volumeLb = (volumeLb ?? 0) + lb * repsDone(set.reps);
    e1rmLb = Math.max(e1rmLb ?? 0, epley(lb, reps));
  }
  return { topLb, volumeLb, e1rmLb };
}

function loadText(load: Load): string {
  switch (load.kind) {
    case 'weight':
      return `${load.amount} ${load.unit}`;
    case 'bodyweight':
      return 'BW';
    case 'band':
      return load.label;
  }
}

function repsText(reps: SetReps): string {
  return reps.kind === 'total' ? `${reps.reps}` : `${reps.left}+${reps.right}`;
}

/** "50 lb x 10/9/8", "30/45/50 lb x 11/10/9", "8 kg/20 lb x 12/10", "BW x 11", "green x 12": the sets as he logged them. */
export function typedLine(sets: readonly SetLog[]): string {
  const loads = sets.map((set) => loadText(set.load));
  const reps = sets.map((set) => repsText(set.reps)).join('/');
  const units = new Set(sets.map((set) => (set.load.kind === 'weight' ? set.load.unit : null)));
  const [unit] = units;
  if (new Set(loads).size === 1) return `${loads[0] ?? ''} x ${reps}`;
  if (units.size === 1 && unit !== null && unit !== undefined) {
    const amounts = sets.map((set) => (set.load.kind === 'weight' ? set.load.amount : '')).join('/');
    return `${amounts} ${unit} x ${reps}`;
  }
  return `${loads.join('/')} x ${reps}`;
}

export interface RepsToGo {
  readonly topLb: number;
  /** The heaviest load as he typed it. */
  readonly load: Load;
  /** The top of the range. */
  readonly top: number;
  /** One row per set at the top load in the order done, then one per prescribed set not done, whose `reps` is null. */
  readonly sets: readonly { readonly reps: number | null; readonly missing: number }[];
  /** Reps from adding weight, counted over the prescribed number of sets, the best ones when there are extras. */
  readonly missing: number;
  /** Every prescribed set reached the top of the range at the top load. */
  readonly ready: boolean;
}

/**
 * How close this performance is to adding weight. Null when the question does not apply: a band
 * or bodyweight load, or no range above zero. Reads the performance's own target, so a range
 * the coach changes later does not rewrite the verdict.
 */
export function repsToGo(performance: Performance): RepsToGo | null {
  const { target } = performance;
  if (target === undefined || target.reps.max === 0 || (target.load ?? 'weight') !== 'weight') return null;
  const { topLb } = totalsOf(performance.sets);
  const atTop = workingSets(performance.sets).filter((set) => lbOf(set.load) === topLb);
  const [first] = atTop;
  if (topLb === null || first === undefined) return null;
  const top = target.reps.max;
  const done = atTop.map((set) => {
    const reps = repsAgainstRange(set.reps);
    return { reps, missing: Math.max(0, top - reps) };
  });
  const undone = Array.from({ length: Math.max(0, target.sets - done.length) }, () => ({ reps: null, missing: top }));
  const sets = [...done, ...undone];
  const missing = sets
    .map((set) => set.missing)
    .toSorted((a, b) => a - b)
    .slice(0, target.sets)
    .reduce((sum, n) => sum + n, 0);
  return { topLb, load: first.load, top, sets, missing, ready: missing === 0 };
}

/** The add-weight hint: the full prescribed set count at the top of the range. */
export function addWeightNext(performance: Performance): boolean {
  return repsToGo(performance)?.ready === true;
}

/** Which of a lift's rows to read. Rows of other lifts are ignored, so a view can pass whatever its seeks returned. */
export interface LiftRead {
  readonly lift: LiftId;
  readonly rows: readonly Performance[];
  readonly book: LiftBook;
}

/** One date of one lift. Two sessions on a date merge: maxima take the larger and volume sums. */
export interface LiftPoint {
  readonly date: LocalDate;
  readonly label: string;
  /** Working sets only. */
  readonly sets: readonly SetLog[];
  readonly totals: ExerciseTotals;
  readonly bestReps: number;
  readonly addWeight: boolean;
}

/** Oldest first. A date with only warm-ups has no point, so it leaves a gap and no dip. */
function pointsOf({ lift, rows, book }: LiftRead): readonly LiftPoint[] {
  const members = new Set(book.members(lift));
  const byDate = new Map<LocalDate, Performance[]>();
  for (const row of rows) {
    if (members.has(row.liftId)) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  }
  return [...byDate.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, performances]) => {
      const sets = performances.flatMap((p) => workingSets(p.sets));
      if (sets.length === 0) return [];
      const label = performances.at(-1)?.label ?? lift;
      return [{ date, label, sets, totals: totalsOf(sets), bestReps: Math.max(...sets.map((set) => repsRead(set.reps))), addWeight: performances.some(addWeightNext) }];
    });
}

function newest(rows: readonly Performance[]): Performance | undefined {
  const lastAt = (row: Performance) => Math.max(0, ...row.sets.map((set) => set.at ?? 0));
  return rows.toSorted((a, b) => a.date.localeCompare(b.date) || lastAt(a) - lastAt(b)).at(-1);
}

/** The lift's newest performance strictly before `before`, including one done as a swap for another lift. */
export function lastTimeOf({ lift, rows, book, before }: LiftRead & { readonly before: LocalDate }): Performance | undefined {
  const members = new Set(book.members(lift));
  return newest(rows.filter((row) => row.date < before && members.has(row.liftId)));
}

/** "Last time here you did X". */
export interface SwapHint {
  readonly date: LocalDate;
  readonly liftId: LiftId;
  readonly label: string;
  readonly line: string;
}

/**
 * The newest swap away from a planned lift, read through plannedLiftId. Undefined once he has
 * done the planned lift again since, because the swap lasted for that session.
 */
export function lastSwapAt(read: LiftRead & { readonly before: LocalDate }): SwapHint | undefined {
  const { lift, rows, book, before } = read;
  const members = new Set(book.members(lift));
  const swap = newest(rows.filter((row) => row.date < before && row.plannedLiftId !== undefined && members.has(row.plannedLiftId) && !members.has(row.liftId)));
  if (swap === undefined) return undefined;
  const own = lastTimeOf(read);
  if (own !== undefined && own.date >= swap.date) return undefined;
  return { date: swap.date, liftId: swap.liftId, label: swap.label, line: typedLine(workingSets(swap.sets)) };
}

/** A row under the add-weight headline. */
export interface RecentSession {
  readonly date: LocalDate;
  readonly label: string;
  readonly line: string;
  readonly topLb: number | null;
  /** The top load went up against the session before that had one. */
  readonly rose: boolean;
}

/** Newest first. */
export function recentSessions(read: LiftRead, limit: number): readonly RecentSession[] {
  let previousTop: number | null = null;
  const rows = pointsOf(read).map((point) => {
    const { topLb } = point.totals;
    const rose = topLb !== null && previousTop !== null && topLb > previousTop;
    if (topLb !== null) previousTop = topLb;
    return { date: point.date, label: point.label, line: typedLine(point.sets), topLb, rose };
  });
  return rows.toReversed().slice(0, limit);
}

/** 'reps' when no point has a weighted set, so a lift never loaded plots reps instead of an empty pound axis. */
export type ChartMode = 'load' | 'reps';

function modeOf(points: readonly LiftPoint[]): ChartMode {
  return points.some((point) => point.totals.e1rmLb !== null) ? 'load' : 'reps';
}

function valueOf(point: LiftPoint, mode: ChartMode): number | null {
  return mode === 'load' ? point.totals.e1rmLb : point.bestReps;
}

export interface Best {
  readonly date: LocalDate;
  readonly value: number;
}

export interface LiftSeries {
  readonly mode: ChartMode;
  readonly points: readonly LiftPoint[];
  /** The point to ring. On a tie the newest, so repeating a best does not read as stuck. */
  readonly best: Best | null;
  /** Dates the lift was planned and he did another, drawn as a tick and a gap, never a dip. */
  readonly swaps: readonly { readonly date: LocalDate; readonly to: string }[];
}

function bestOf(points: readonly LiftPoint[], mode: ChartMode): Best | null {
  let best: Best | null = null;
  for (const point of points) {
    const value = valueOf(point, mode);
    if (value !== null && (best === null || value >= best.value)) best = { date: point.date, value };
  }
  return best;
}

export function liftSeries(read: LiftRead): LiftSeries {
  const points = pointsOf(read);
  const mode = modeOf(points);
  const members = new Set(read.book.members(read.lift));
  const swaps = read.rows
    .filter((row) => row.plannedLiftId !== undefined && members.has(row.plannedLiftId) && !members.has(row.liftId))
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({ date: row.date, to: row.label }));
  return { mode, points, best: bestOf(points, mode), swaps };
}

export const BOARD_WEEKS = 12;

export interface BoardRow {
  readonly liftId: LiftId;
  readonly name: string;
  readonly mode: ChartMode;
  /** Est. 1RM in lb, or best reps in reps mode, oldest first. */
  readonly spark: readonly number[];
  readonly latest: number | null;
  /** latest less the first value in the window. Null under two points. */
  readonly change: number | null;
  /** Sessions since the window's best, for "best 5 sessions ago". */
  readonly sessionsSinceBest: number | null;
}

/** A key lift over the last BOARD_WEEKS weeks. */
export function boardRow(read: LiftRead & { readonly today: LocalDate }): BoardRow {
  const from = addDays(read.today, -7 * BOARD_WEEKS);
  const points = pointsOf(read).filter((point) => point.date > from && point.date <= read.today);
  const mode = modeOf(points);
  const spark = points.flatMap((point) => valueOf(point, mode) ?? []);
  const latest = spark.at(-1) ?? null;
  const first = spark[0];
  const best = spark.length === 0 ? null : spark.lastIndexOf(Math.max(...spark));
  return {
    liftId: read.lift,
    name: read.book.nameOf(read.lift) ?? read.lift,
    mode,
    spark,
    latest,
    change: latest === null || first === undefined || spark.length < 2 ? null : latest - first,
    sessionsSinceBest: best === null ? null : spark.length - 1 - best,
  };
}

/** A session counts when it has a working set, a finish, or came from the import. A session opened and left empty does not. */
export function sessionsDone(sessions: readonly Session[], performances: readonly Performance[]): readonly Session[] {
  const worked = new Set<SessionId>(performances.filter((p) => workingSets(p.sets).length > 0).map((p) => p.sessionId));
  return sessions.filter((session) => session.finishedAt !== undefined || session.source === 'notion' || worked.has(session.id));
}

export interface Skip {
  readonly slotId: SlotId;
  readonly label: string;
  readonly note: string | null;
}

/**
 * A required slot with no working set under it, tapped or not, once the session is over. While
 * it is open only tapped skips count, because the rest may still come. A day never started has
 * none. With no plan to read, as on an import, tapped skips are all there is.
 */
export function skipsOf(input: {
  readonly session: Session;
  readonly performances: readonly Performance[];
  readonly plan: PlannedDay | undefined;
  readonly phase: SessionPhase;
}): readonly Skip[] {
  const { session, plan, phase } = input;
  const performances = input.performances.filter((p) => p.sessionId === session.id);
  const notes = new Map((session.skips ?? []).map((skip) => [skip.slotId, skip.note ?? null]));
  const over = phase !== 'open' && sessionsDone([session], performances).length > 0;
  const worked = new Set(performances.filter((p) => workingSets(p.sets).length > 0).map((p) => p.slotId));
  const required = (plan?.blocks ?? []).flatMap((block) => (block.kind === 'lifts' && block.optional !== true ? block.slots : []));
  const fromPlan = required.filter((slot) => !worked.has(slot.id) && (over || notes.has(slot.id))).map((slot) => ({ slotId: slot.id, label: slot.label, note: notes.get(slot.id) ?? null }));
  const inPlan = new Set(required.map((slot) => slot.id));
  const offPlan = [...notes].filter(([slotId]) => !inPlan.has(slotId)).map(([slotId, note]) => ({ slotId, label: slotId, note }));
  return [...fromPlan, ...offPlan];
}

export interface Swap {
  readonly date: LocalDate;
  readonly plannedLiftId: LiftId;
  readonly liftId: LiftId;
  readonly label: string;
}

export function swapsOf(performances: readonly Performance[]): readonly Swap[] {
  return performances.flatMap((p) => (p.plannedLiftId === undefined ? [] : [{ date: p.date, plannedLiftId: p.plannedLiftId, liftId: p.liftId, label: p.label }]));
}

export const SHOW_UP_WEEKS = 12;

export interface ShowUpWeek {
  readonly monday: LocalDate;
  readonly done: number;
  readonly met: boolean;
}

export interface ShowUp {
  readonly minimum: number | null;
  /** Oldest first, ending with the week holding `today`. */
  readonly weeks: readonly ShowUpWeek[];
}

/** Sessions done per week against the weekly minimum. With no minimum, no week is `met`. */
export function showUp(input: { readonly sessions: readonly Session[]; readonly performances: readonly Performance[]; readonly minimum: number | null; readonly today: LocalDate }): ShowUp {
  const { minimum } = input;
  const counts = new Map<LocalDate, number>();
  for (const session of sessionsDone(input.sessions, input.performances)) {
    const monday = mondayOf(session.date);
    counts.set(monday, (counts.get(monday) ?? 0) + 1);
  }
  const thisWeek = mondayOf(input.today);
  const weeks = Array.from({ length: SHOW_UP_WEEKS }, (_, i) => {
    const monday = addDays(thisWeek, -7 * (SHOW_UP_WEEKS - 1 - i));
    const done = counts.get(monday) ?? 0;
    return { monday, done, met: minimum !== null && done >= minimum };
  });
  return { minimum, weeks };
}
