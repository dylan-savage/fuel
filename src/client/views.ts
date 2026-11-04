/**
 * Read models for screens and the hooks that serve them. Each view reads replica documents
 * and hands them to pure domain functions. useLive re-renders on local writes and sync
 * merges alike.
 */
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { bodyWeightOn, projectGoal, trendSeries, weeklyRate, weighInId, type BodyWeight, type Projection, type TrendPoint, type WeeklyRate, type WeighIn } from '../domain/body.js';
import { recentWorkouts, type Workout, type WorkoutDraft } from '../domain/burn.js';
import { coachWeek, type CoachWeek } from '../domain/coach.js';
import { summarizeDay, type DaySummary } from '../domain/diary.js';
import type { Food, Gtin } from '../domain/food.js';
import { PROFILE_ID, budgetOn, goalOn, type Budget, type BudgetPolicy, type Goal, type Profile } from '../domain/goals.js';
import {
  fastHistory,
  fastState,
  fastStreak,
  nextTargetHours,
  waterGoalMl,
  withEnds,
  waterTotalMl,
  type FastSession,
  type FastState,
  type Streak,
  type Water,
} from '../domain/habits.js';
import { LocalDate, addDays, mondayOf, type Millis } from '../domain/ids.js';
import { liftBook, type Lift, type LiftBook, type LiftId, type Performance, type SlotId } from '../domain/lifts.js';
import { RECENT_DAYS, recents, type Library, type RecentFood } from '../domain/library.js';
import { dayNotesFor, dayParts, notesFor, plannedDay, type DayKey, type DayPart, type PlannedDay, type Program, type ProgramNote, type StandingText } from '../domain/program.js';
import {
  BOARD_MIN,
  BOARD_WEEKS,
  SHOW_UP_WEEKS,
  boardRow,
  lastLineOf,
  latestOf,
  latestRepsToGo,
  liftSeriesByRange,
  loggedLifts,
  recentSessions,
  showUp,
  weekProgress,
  weekUnfinished,
  type BoardRow,
  type ChartMode,
  type LastLine,
  type LiftPoint,
  type LiftRange,
  type LiftSeries,
  type LoggedLift,
  type RecentSession,
  type RepsToGo,
  type ShowUp,
  type WeekProgress,
} from '../domain/progress.js';
import { refreshFor, type EditedRef, type Recipe, type Refresh, type SavedMeal } from '../domain/reuse.js';
import { cardioDoneOn, isUnfinished, sessionPhase, type Session, type SessionLogs } from '../domain/session.js';
import { localDate } from './clock.js';
import type { Intents } from './intents.js';
import type { Replica, ReplicaReader, Subscribable } from './replica.js';
import type { SyncState } from './sync.js';

export interface DayView {
  readonly summary: DaySummary;
  /** Oldest first. */
  readonly workouts: readonly Workout[];
  /** Null before any goal, or while a computed goal has no profile. */
  readonly budget: Budget | null;
  /** How the goal in effect that day treats workouts. */
  readonly policy: BudgetPolicy | undefined;
}

export async function dayView(r: ReplicaReader, date: LocalDate): Promise<DayView> {
  const [entries, workouts, goals, profile, weighIns] = await Promise.all([
    r.onDate('entry', date),
    r.onDate('workout', date),
    r.all('goal'),
    r.get('profile', PROFILE_ID),
    r.all('weighIn'),
  ]);
  return {
    summary: summarizeDay(entries),
    workouts: workouts.toSorted((a, b) => a.loggedAt - b.loggedAt),
    budget: budgetOn({ goals, profile, weighIns, workouts, date }),
    policy: goalOn(goals, date)?.policy,
  };
}

/** Every food and recipe logged in the last RECENT_DAYS, most used first. */
export async function recentsView(r: ReplicaReader, at: { readonly today: LocalDate; readonly now: Millis }): Promise<RecentFood[]> {
  const [entries, library] = await Promise.all([r.between('entry', addDays(at.today, -RECENT_DAYS), at.today), libraryView(r)]);
  return recents({ entries, library, now: at.now, limit: Number.POSITIVE_INFINITY });
}

export async function libraryView(r: ReplicaReader): Promise<Library> {
  const [foods, recipes] = await Promise.all([r.all('food'), r.all('recipe')]);
  return { foods, recipes };
}

const byName = (a: { readonly name: string }, b: { readonly name: string }) => a.name.localeCompare(b.name);

export async function recipesView(r: ReplicaReader): Promise<Recipe[]> {
  return (await r.all('recipe')).filter((recipe) => !recipe.archived).toSorted(byName);
}

export async function savedMealsView(r: ReplicaReader): Promise<SavedMeal[]> {
  return (await r.all('savedMeal')).filter((meal) => !meal.archived).toSorted(byName);
}

/** The recipes and saved meals that the edited food's or recipe's current version would update. */
export async function usesView(r: ReplicaReader, ref: EditedRef): Promise<Refresh> {
  const [recipes, meals, edited] = await Promise.all([
    r.all('recipe'),
    r.all('savedMeal'),
    ref.kind === 'food'
      ? r.get('food', ref.id).then((food) => food && { kind: 'food' as const, food })
      : r.get('recipe', ref.id).then((recipe) => recipe && { kind: 'recipe' as const, recipe }),
  ]);
  return edited === undefined ? { recipes: [], meals: [] } : refreshFor(edited, { recipes, meals });
}

/** The library food a scanned barcode names, if any. Archived foods still answer a scan. */
export async function foodWithBarcode(r: ReplicaReader, gtin: Gtin): Promise<Food | undefined> {
  const foods = await r.withBarcode(gtin);
  return foods.find((f) => !f.archived) ?? foods[0];
}

/** The rows lastTimeOf and lastSwapAt read: two seeks per id, so hand in every id the book counts as these lifts. */
export async function lastTimesView(r: ReplicaReader, liftIds: readonly LiftId[], before: LocalDate): Promise<Performance[]> {
  const [own, swaps] = await Promise.all([r.lastPerformances(liftIds, before), r.lastSwaps(liftIds, before)]);
  return [...own, ...swaps];
}

/** The versions that took effect since `monday`, walked back one seek at a time, and the one they followed. */
async function coachWeekView(r: ReplicaReader, inEffect: Program, monday: LocalDate): Promise<CoachWeek> {
  const thisWeek: Program[] = [];
  let version: Program | undefined = inEffect;
  while (version !== undefined && version.effectiveFrom >= monday) {
    thisWeek.unshift(version);
    version = await r.programOn(addDays(version.effectiveFrom, -1));
  }
  return coachWeek(version ?? null, thisWeek);
}

/** The Sunday review publishes for Monday, so its report shows when it lands instead of a day later. */
async function coachCard(r: ReplicaReader, inEffect: Program, monday: LocalDate, today: LocalDate): Promise<CoachWeek> {
  const upcoming = await r.programOn(addDays(monday, 7));
  if (upcoming !== undefined && upcoming.effectiveFrom > today && upcoming.report !== undefined) return coachWeek(inEffect, [upcoming]);
  return coachWeekView(r, inEffect, monday);
}

export interface WeekView extends WeekProgress {
  readonly minimum: number | null;
  readonly coach: CoachWeek;
  /** The week's own notes in effect. A note naming a day is on that day's preview. */
  readonly notes: readonly ProgramNote[];
  readonly standing: readonly StandingText[];
  readonly weighedInToday: boolean;
}

/**
 * The week holding `today`, under the version in effect. Null before any version is. A set
 * logged re-runs this, because it counts toward the week, so last-time lines read separately.
 */
export async function weekView(r: ReplicaReader, today: LocalDate): Promise<WeekView | null> {
  const program = await r.programOn(today);
  if (program === undefined) return null;
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const [sessions, performances, weighIn, coach] = await Promise.all([
    r.between('session', monday, sunday),
    r.between('performance', monday, sunday),
    r.get('weighIn', weighInId(today)),
    coachCard(r, program, monday, today),
  ]);
  return {
    ...weekProgress({ program, sessions, performances, today }),
    minimum: program.weeklyMinimum ?? null,
    coach,
    notes: notesFor(program, today),
    standing: program.standing,
    weighedInToday: weighIn !== undefined,
  };
}

export interface PlannedDayView {
  readonly plan: PlannedDay;
  readonly notes: readonly ProgramNote[];
  readonly book: LiftBook;
}

/** One day under the version in effect. Reads no logs, so a logged set does not re-run it. Null when that week does not hold the day. */
export async function plannedDayView(r: ReplicaReader, key: DayKey, date: LocalDate): Promise<PlannedDayView | null> {
  const program = await r.programOn(date);
  const plan = program === undefined ? undefined : plannedDay(program, key, date);
  if (program === undefined || plan === undefined) return null;
  return { plan, notes: dayNotesFor(program, key, date), book: liftBook(program.lifts) };
}

export interface DayPreview {
  readonly notes: readonly ProgramNote[];
  readonly parts: readonly DayPart[];
  /** Slot ids are unique within a day. Null before the lift was done. */
  readonly lasts: ReadonlyMap<SlotId, LastLine | null>;
}

/** A day as its preview reads. Its reads stop at the day before `today`, so a set logged today does not re-run it. */
export async function dayPreviewView(r: ReplicaReader, key: DayKey, today: LocalDate): Promise<DayPreview | null> {
  const planned = await plannedDayView(r, key, today);
  if (planned === null) return null;
  const { plan, notes, book } = planned;
  const slots = plan.blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots : []));
  const rows = await lastTimesView(r, [...new Set(slots.flatMap((slot) => book.members(slot.liftId)))], today);
  return {
    notes,
    parts: dayParts(plan),
    lasts: new Map(slots.map((slot) => [slot.id, lastLineOf({ lift: slot.liftId, rows, book, before: today })])),
  };
}

/** A session's sets and whether cardio on its date satisfies its cardio blocks. */
export async function sessionLogsView(r: ReplicaReader, session: Session): Promise<SessionLogs> {
  const [performances, workouts] = await Promise.all([r.performancesOfSession(session.id), r.onDate('workout', session.date)]);
  return { session, performances, cardioDone: cardioDoneOn(session, workouts) };
}

/** Enough to carry a session across a midnight, and few enough thin rows to read before the first paint. */
const OPEN_SESSION_DAYS = 2;

/** The session in progress, with its sets, so the position and the rest they imply come from one read. Null with none. */
export async function openSessionView(r: ReplicaReader, at: { readonly today: LocalDate; readonly now: Millis }): Promise<SessionLogs | null> {
  const recent = await r.between('session', addDays(at.today, -OPEN_SESSION_DAYS), at.today);
  const reads = await Promise.all(recent.filter(isUnfinished).map((session) => sessionLogsView(r, session)));
  return (
    reads
      .filter((logs) => sessionPhase(logs, at.now) === 'open')
      .toSorted((a, b) => (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0))
      .at(-1) ?? null
  );
}

export interface SessionPlan {
  readonly plan: PlannedDay;
  readonly parts: readonly DayPart[];
  readonly notes: readonly ProgramNote[];
  readonly book: LiftBook;
  /** The catalog a swap searches. */
  readonly lifts: readonly Lift[];
}

/** A session's plan from the version it pinned, so a version published since changes nothing on the card. Null when this phone does not hold that version. */
export async function sessionPlanView(r: ReplicaReader, session: Session): Promise<SessionPlan | null> {
  if (session.programId === undefined || session.day === undefined) return null;
  const program = await r.get('program', session.programId);
  const plan = program === undefined ? undefined : plannedDay(program, session.day.key, session.date);
  if (program === undefined || plan === undefined) return null;
  return { plan, parts: dayParts(plan), notes: dayNotesFor(program, plan.key, session.date), book: liftBook(program.lifts), lifts: program.lifts };
}

/** Every id whose last time a running session can show: its plan, what it has logged, and swaps chosen with no set yet. */
export function sessionLiftIds({ plan, book }: SessionPlan, performances: readonly Performance[], swaps: readonly { readonly liftId: LiftId }[]): readonly LiftId[] {
  const slots = plan.blocks.flatMap((block) => (block.kind === 'lifts' ? block.slots : []));
  return [...new Set([...slots, ...performances, ...swaps].flatMap(({ liftId }) => book.members(liftId)))].toSorted();
}

export interface ShowUpView extends ShowUp {
  /** Sessions done this week. */
  readonly done: number;
  /** Days the version in effect holds this week. */
  readonly planned: number;
  readonly unfinished: boolean;
}

/** Twelve weeks of sessions against the minimum. The reads are bounded by those weeks, whatever the history holds. */
export async function showUpView(r: ReplicaReader, today: LocalDate): Promise<ShowUpView> {
  const monday = mondayOf(today);
  const from = addDays(monday, -7 * (SHOW_UP_WEEKS - 1));
  const to = addDays(monday, 6);
  const [program, sessions, performances] = await Promise.all([r.programOn(today), r.between('session', from, to), r.between('performance', from, to)]);
  const shown = showUp({ sessions, performances, minimum: program?.weeklyMinimum ?? null, today });
  const planned = program === undefined ? 0 : weekProgress({ program, sessions: [], performances: [], today }).days.length;
  const done = shown.weeks.at(-1)?.done ?? 0;
  return { ...shown, done, planned, unfinished: weekUnfinished(done, shown.minimum, planned) };
}

/** The key lifts in catalog order. Two seeks per id, so the rest of the history is never read. */
export async function boardView(r: ReplicaReader, today: LocalDate): Promise<readonly BoardRow[]> {
  const program = await r.programOn(today);
  if (program === undefined) return [];
  const book = liftBook(program.lifts);
  const from = addDays(today, -7 * BOARD_WEEKS);
  const doneIn = async (lifts: readonly LiftId[]) => {
    const rows = await r.performancesFrom(
      lifts.flatMap((lift) => book.members(lift)),
      from,
    );
    return lifts.map((lift) => boardRow({ lift, rows, book, today })).filter((row) => row.latest !== null);
  };
  const keys = await doneIn(program.lifts.filter((lift) => lift.key === true).map((lift) => lift.id));
  if (keys.length >= BOARD_MIN) return keys;
  const others = loggedLifts(await r.newestOfEachLift(), book).filter((lift) => lift.lastDate > from && !keys.some((key) => key.liftId === lift.liftId));
  const filled = await doneIn(others.map((lift) => lift.liftId));
  return [...keys, ...filled.slice(0, BOARD_MIN - keys.length)];
}

/** Every lift ever logged, most recent first, including names the catalog has not placed yet. */
export async function loggedLiftsView(r: ReplicaReader, today: LocalDate): Promise<readonly LoggedLift[]> {
  const [program, newest] = await Promise.all([r.programOn(today), r.newestOfEachLift()]);
  return loggedLifts(newest, liftBook(program?.lifts ?? []));
}

export interface LiftChartView {
  /** Whichever range is shown, so the headline does not change under him. */
  readonly latest: LiftPoint | null;
  readonly latestMode: ChartMode;
  readonly ranges: Readonly<Record<LiftRange, LiftSeries>>;
  readonly toGo: RepsToGo | null;
  /** Every session, newest first. */
  readonly recent: readonly RecentSession[];
}

/** Earlier than any training log, so a read from here is a lift's whole history. */
const BEFORE_ANY_LOG = LocalDate.parse('2000-01-01');

/**
 * One lift's whole history, read once and cut by range in memory: the rows under the bars need
 * the sessions before any range, and two seeks per id stay small however much else is stored.
 */
export async function liftChartView(r: ReplicaReader, lift: LiftId, today: LocalDate): Promise<LiftChartView> {
  const program = await r.programOn(today);
  const book = liftBook(program?.lifts ?? []);
  const rows = (await r.performancesFrom(book.members(lift), BEFORE_ANY_LOG)).filter((row) => row.date <= today);
  const read = { lift, rows, book };
  const ranges = liftSeriesByRange({ ...read, today });
  return {
    latest: latestOf(ranges.all),
    latestMode: ranges.all.mode,
    ranges,
    toGo: latestRepsToGo({ ...read, before: addDays(today, 1) }),
    recent: recentSessions(read, Number.POSITIVE_INFINITY),
  };
}

export interface GoalView {
  readonly profile: Profile | undefined;
  /** The goal in effect today. */
  readonly goal: Goal | undefined;
  /** Every weigh-in, for BMR from today's trend. */
  readonly weighIns: readonly WeighIn[];
  /** Today's trend weight, once there is a weigh-in. */
  readonly trendKg: number | undefined;
}

export async function goalView(r: ReplicaReader, today: LocalDate): Promise<GoalView> {
  const [profile, goals, weighIns] = await Promise.all([r.get('profile', PROFILE_ID), r.all('goal'), r.all('weighIn')]);
  return { profile, goal: goalOn(goals, today), weighIns, trendKg: trendSeries(weighIns, today).at(-1)?.trendKg };
}

export interface WaterView {
  /** Oldest first. */
  readonly drinks: readonly Water[];
  readonly totalMl: number;
  readonly goalMl: number;
}

export async function waterView(r: ReplicaReader, date: LocalDate): Promise<WaterView> {
  const [drinks, goals] = await Promise.all([r.onDate('water', date), r.all('goal')]);
  return { drinks: drinks.toSorted((a, b) => a.loggedAt - b.loggedAt), totalMl: waterTotalMl(drinks), goalMl: waterGoalMl(goalOn(goals, date)) };
}

export interface FastView {
  readonly state: FastState;
  /** Newest first. */
  readonly history: readonly FastSession[];
  readonly streak: Streak;
  readonly nextTargetHours: number;
}

/** The fasting timer's state, history and streak. Streak days are this phone's calendar days. */
export async function fastView(r: ReplicaReader, today: LocalDate): Promise<FastView> {
  const [fasts, ends] = await Promise.all([r.all('fast'), r.all('fastEnd')]);
  const timed = withEnds(fasts, ends);
  const history = fastHistory(timed);
  return {
    state: fastState(timed),
    history,
    streak: fastStreak(history, { today, dayOf: (at) => localDate(new Date(at)) }),
    nextTargetHours: nextTargetHours(fasts),
  };
}

export interface BodyView {
  /** One point a day from the first weigh-in through the day asked for. */
  readonly series: readonly TrendPoint[];
  /** Newest first, up to the day asked for. */
  readonly weighIns: readonly WeighIn[];
  /** The trend on the day asked for. */
  readonly trendKg: number | undefined;
  readonly rate: WeeklyRate;
  /** The goal weight of the goal in effect that day. */
  readonly goalKg: number | undefined;
  readonly projection: Projection;
}

/** The weight trend, rate and goal projection as they stand on `date`. */
export async function bodyView(r: ReplicaReader, date: LocalDate): Promise<BodyView> {
  const [weighIns, goals] = await Promise.all([r.all('weighIn'), r.all('goal')]);
  const series = trendSeries(weighIns, date);
  const trendKg = series.at(-1)?.trendKg;
  const rate = weeklyRate(series);
  const goalKg = goalOn(goals, date)?.goalWeightKg;
  return {
    series,
    weighIns: weighIns.filter((w) => w.date <= date).toSorted((a, b) => b.date.localeCompare(a.date)),
    trendKg,
    rate,
    goalKg,
    projection: projectGoal({ trendKg, rate, goalKg, from: date }),
  };
}

/** Every weigh-in, newest first: what the weigh-in sheet checks a picked day against. */
export async function weighInsView(r: ReplicaReader): Promise<WeighIn[]> {
  return (await r.all('weighIn')).toSorted((a, b) => b.date.localeCompare(a.date));
}

export interface WorkoutLoggerView {
  /** The weight a new workout on the day is worked out at. Undefined before any weigh-in or profile. */
  readonly weight: BodyWeight | undefined;
  /** Workouts to log again in a tap, newest first. */
  readonly recents: readonly WorkoutDraft[];
}

export async function workoutLoggerView(r: ReplicaReader, date: LocalDate): Promise<WorkoutLoggerView> {
  const [weighIns, profile, workouts] = await Promise.all([r.all('weighIn'), r.get('profile', PROFILE_ID), r.all('workout')]);
  return { weight: bodyWeightOn(weighIns, profile, date), recents: recentWorkouts(workouts, 4) };
}

/** Writes made on this phone that the mini has not acknowledged. */
export function waitingView(r: ReplicaReader): Promise<number> {
  return r.pendingCount();
}

/** Everything a screen may touch: reads, intents and sync status. No commit, no outbox. */
export interface Fuel {
  readonly replica: Pick<Replica, 'live' | 'read'>;
  readonly intents: Intents;
  readonly sync: Subscribable<SyncState>;
}

export const FuelContext = createContext<Fuel | null>(null);

function useFuel(): Fuel {
  const fuel = useContext(FuelContext);
  if (fuel === null) throw new Error('FuelContext is not provided');
  return fuel;
}

/** undefined only until IndexedDB first answers. */
export function useLive<T>(query: (r: ReplicaReader) => Promise<T>, deps: readonly unknown[]): T | undefined {
  const { replica } = useFuel();
  const [value, setValue] = useState<{ current: T }>();
  useEffect(() => replica.live(query).subscribe((current) => setValue({ current })), deps);
  return value?.current;
}

/** A one-off read for event handlers, such as resolving a scanned barcode. */
export function useRead(): <T>(query: (r: ReplicaReader) => Promise<T>) => Promise<T> {
  const { replica } = useFuel();
  return useCallback((query) => query(replica.read), [replica]);
}

export function useIntents(): Intents {
  return useFuel().intents;
}

export function useSyncState(): SyncState | undefined {
  const { sync } = useFuel();
  const [state, setState] = useState<SyncState>();
  useEffect(() => sync.subscribe(setState), [sync]);
  return state;
}
