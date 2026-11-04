import { KG_PER_LB } from './goals.js';
import { addDays, mondayOf, weekdayOf, type LocalDate, type SessionId } from './ids.js';
import type { LiftBook, LiftId, Load, Performance, SetLog, SetReps, SlotId, Unit } from './lifts.js';
import { plannedDay, type DayKey, type PlannedDay, type Program } from './program.js';
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

/** "55 lb", "25 kg", "BW", "green". */
export function loadText(load: Load): string {
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
export function typedLine(sets: readonly SetLog[], times = 'x'): string {
  const loads = sets.map((set) => loadText(set.load));
  const reps = sets.map((set) => repsText(set.reps)).join('/');
  const units = new Set(sets.map((set) => (set.load.kind === 'weight' ? set.load.unit : null)));
  const [unit] = units;
  if (new Set(loads).size === 1) return `${loads[0] ?? ''} ${times} ${reps}`;
  if (units.size === 1 && unit !== null && unit !== undefined) {
    const amounts = sets.map((set) => (set.load.kind === 'weight' ? set.load.amount : '')).join('/');
    return `${amounts} ${unit} ${times} ${reps}`;
  }
  return `${loads.join('/')} ${times} ${reps}`;
}

/** "50 × 12, 50 × 12, 20 kg × 8, BW × 11": set by set as typed. Pounds are the app's unit, so they go unwritten. */
export function setsLine(sets: readonly SetLog[]): string {
  return sets.map(({ load, reps }) => `${load.kind === 'weight' && load.unit === 'lb' ? load.amount : loadText(load)} × ${repsText(reps)}`).join(', ');
}

export interface RepsToGo {
  readonly topLb: number;
  /** The heaviest load as he typed it. */
  readonly load: Load;
  /** The top of the range. */
  readonly top: number;
  /** The sets the range asks for. */
  readonly prescribed: number;
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
  return { topLb, load: first.load, top, prescribed: target.sets, sets, missing, ready: missing === 0 };
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

/** What an exercise shows of its last time. */
export interface LastLine {
  readonly date: LocalDate;
  /** The working sets as typed, such as "62.5 kg × 8/8/6". */
  readonly line: string;
  readonly addWeight: boolean;
}

/** Null before he has done the lift, and when last time holds only warm-ups, which say nothing about the working weight. */
export function lastLineOf(read: LiftRead & { readonly before: LocalDate }): LastLine | null {
  const last = lastTimeOf(read);
  const working = last === undefined ? [] : workingSets(last.sets);
  return last === undefined || working.length === 0 ? null : { date: last.date, line: typedLine(working, '×'), addWeight: addWeightNext(last) };
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
  /** The top load as typed. With no weight on the bar, whatever it was loaded with. */
  readonly load: string;
  /** Reps at that load in the order done, such as "12, 12, 10" or "10+9, 9+9". */
  readonly reps: string;
  /** How far the top load rose, in the unit it was typed in, to a tenth. Null when it did not rise. */
  readonly added: { readonly amount: number; readonly unit: Unit } | null;
}

/** Newest first. */
export function recentSessions(read: LiftRead, limit: number): readonly RecentSession[] {
  let previousTop: number | null = null;
  const rows = pointsOf(read).map((point) => {
    const { topLb } = point.totals;
    const atTop = topLb === null ? point.sets : point.sets.filter((set) => lbOf(set.load) === topLb);
    const unit = atTop.flatMap((set) => (set.load.kind === 'weight' ? [set.load.unit] : []))[0] ?? 'lb';
    const gainLb = topLb !== null && previousTop !== null && topLb > previousTop ? topLb - previousTop : null;
    if (topLb !== null) previousTop = topLb;
    return {
      date: point.date,
      label: point.label,
      line: typedLine(point.sets),
      topLb,
      rose: gainLb !== null,
      load: [...new Set(atTop.map((set) => loadText(set.load)))].join('/'),
      reps: atTop.map((set) => repsText(set.reps)).join(', '),
      added: gainLb === null ? null : { amount: Math.round((unit === 'lb' ? gainLb : gainLb * KG_PER_LB) * 10) / 10, unit },
    };
  });
  return rows.toReversed().slice(0, limit);
}

/** How close the lift's newest session with a working set is to adding weight. A day of only warm-ups says nothing about it. */
export function latestRepsToGo(read: LiftRead & { readonly before: LocalDate }): RepsToGo | null {
  const last = lastTimeOf({ ...read, rows: read.rows.filter((row) => workingSets(row.sets).length > 0) });
  return last === undefined ? null : repsToGo(last);
}

/** 'reps' when no point has a weighted set, so a lift never loaded plots reps instead of an empty pound axis. */
export type ChartMode = 'load' | 'reps';

function modeOf(points: readonly LiftPoint[]): ChartMode {
  return points.some((point) => point.totals.e1rmLb !== null) ? 'load' : 'reps';
}

/** What a chart plots for this date. Null on a bodyweight or band day of a loaded lift, never 0. */
export function valueOf(point: LiftPoint, mode: ChartMode): number | null {
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

/** What the line connects. A date with no value is left out, so the line bridges it rather than dipping to 0. */
export function lineOf({ mode, points }: LiftSeries): readonly { readonly date: LocalDate; readonly value: number }[] {
  return points.flatMap((point) => {
    const value = valueOf(point, mode);
    return value === null ? [] : [{ date: point.date, value }];
  });
}

/** The newest point with something to plot, so a headline's number and its date come from one session. */
export function latestOf({ mode, points }: LiftSeries): LiftPoint | null {
  return points.findLast((point) => valueOf(point, mode) !== null) ?? null;
}

/** How far back a lift chart looks, in days, with `all` having no limit. */
export const LIFT_RANGE_DAYS = { '3m': 91, '1y': 365, all: null } as const;
export type LiftRange = keyof typeof LIFT_RANGE_DAYS;

/** The series as each range sees it, so a best is the best of what is on screen and a range change reads nothing. */
export function liftSeriesByRange(read: LiftRead & { readonly today: LocalDate }): Readonly<Record<LiftRange, LiftSeries>> {
  const within = (days: number | null) => {
    if (days === null) return liftSeries(read);
    const from = addDays(read.today, -days);
    return liftSeries({ ...read, rows: read.rows.filter((row) => row.date > from) });
  };
  return { '3m': within(LIFT_RANGE_DAYS['3m']), '1y': within(LIFT_RANGE_DAYS['1y']), all: within(LIFT_RANGE_DAYS.all) };
}

/** A row of the list of every lift ever logged. */
export interface LoggedLift {
  readonly liftId: LiftId;
  readonly name: string;
  readonly lastDate: LocalDate;
}

/** `newest` holds each lift's newest row, as the index gives them. Aliases fold into their lift. Most recent first. */
export function loggedLifts(newest: readonly Performance[], book: LiftBook): readonly LoggedLift[] {
  const lifts = new Map<LiftId, LoggedLift>();
  for (const row of newest) {
    const liftId = book.canonical(row.liftId);
    const known = lifts.get(liftId);
    if (known === undefined || row.date > known.lastDate) lifts.set(liftId, { liftId, name: book.nameOf(liftId) ?? row.label, lastDate: row.date });
  }
  return [...lifts.values()].toSorted((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
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

const STALE_BEST_SESSIONS = 3;

/** Sessions since the best when that is worth saying. A session or two past a best is ordinary, and says nothing about being stuck. */
export function staleBest({ sessionsSinceBest }: BoardRow): number | null {
  return sessionsSinceBest !== null && sessionsSinceBest >= STALE_BEST_SESSIONS ? sessionsSinceBest : null;
}

/** A session counts when it has a working set, a finish, or came from the import. A session opened and left empty does not. */
export function sessionsDone(sessions: readonly Session[], performances: readonly Performance[]): readonly Session[] {
  const worked = new Set<SessionId>(performances.filter((p) => workingSets(p.sets).length > 0).map((p) => p.sessionId));
  return sessions.filter((session) => session.finishedAt !== undefined || session.source === 'notion' || worked.has(session.id));
}

/** One day of a week's plan, with whether he has trained it. */
export interface WeekDay {
  readonly plan: PlannedDay;
  readonly weekday: number | undefined;
  /** When he trained it, which need not be the planned weekday. Matched by day key, so a version published mid-week keeps it. */
  readonly doneOn: LocalDate | null;
}

export interface WeekProgress {
  /** Ordered by weekday. A day with no weekday follows, in the plan's order. */
  readonly days: readonly WeekDay[];
  /** Sessions done, as showUp and the coach count them, including any that name no planned day. */
  readonly done: number;
  /** One per planned day. A session naming no planned day fills the first empty one, so the strip agrees with `done`. */
  readonly strip: readonly boolean[];
  /** The first undone day, or today's weekday if that is undone. */
  readonly suggested: PlannedDay | null;
}

/** `sessions` and `performances` are that week's. */
export function weekProgress(input: { readonly program: Program; readonly sessions: readonly Session[]; readonly performances: readonly Performance[]; readonly today: LocalDate }): WeekProgress {
  const { program, today } = input;
  const done = sessionsDone(input.sessions, input.performances);
  const doneOn = new Map<DayKey, LocalDate>();
  for (const session of done.toSorted((a, b) => a.date.localeCompare(b.date))) {
    if (session.day !== undefined && !doneOn.has(session.day.key)) doneOn.set(session.day.key, session.date);
  }
  const days = program.days
    .toSorted((a, b) => (a.weekday ?? 8) - (b.weekday ?? 8))
    .flatMap((day): readonly WeekDay[] => {
      const plan = plannedDay(program, day.key, today);
      return plan === undefined ? [] : [{ plan, weekday: day.weekday, doneOn: doneOn.get(day.key) ?? null }];
    });
  let spare = done.length - days.filter((day) => day.doneOn !== null).length;
  const strip = days.map((day) => day.doneOn !== null || spare-- > 0);
  const undone = days.filter((day) => day.doneOn === null);
  const suggested = undone.find((day) => day.weekday === weekdayOf(today)) ?? undone[0];
  return { days, done: done.length, strip, suggested: suggested?.plan ?? null };
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

/** A week still short of its minimum, or of its plan when there is no minimum. */
export function weekUnfinished(done: number, minimum: number | null, planned: number): boolean {
  return done < (minimum ?? planned);
}
