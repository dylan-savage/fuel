/**
 * Read models for screens and the hooks that serve them. Each view reads replica documents
 * and hands them to pure domain functions. useLive re-renders on local writes and sync
 * merges alike.
 */
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { bodyWeightOn, projectGoal, trendSeries, weeklyRate, type BodyWeight, type Projection, type TrendPoint, type WeeklyRate, type WeighIn } from '../domain/body.js';
import { recentWorkouts, type Workout, type WorkoutDraft } from '../domain/burn.js';
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
import { addDays, type LocalDate, type Millis } from '../domain/ids.js';
import { RECENT_DAYS, recents, type Library, type RecentFood } from '../domain/library.js';
import { refreshFor, type EditedRef, type Recipe, type Refresh, type SavedMeal } from '../domain/reuse.js';
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

export interface GoalView {
  readonly profile: Profile | undefined;
  /** The goal in effect today. */
  readonly goal: Goal | undefined;
  /** Every weigh-in, for BMR from today's trend. */
  readonly weighIns: readonly WeighIn[];
}

export async function goalView(r: ReplicaReader, today: LocalDate): Promise<GoalView> {
  const [profile, goals, weighIns] = await Promise.all([r.get('profile', PROFILE_ID), r.all('goal'), r.all('weighIn')]);
  return { profile, goal: goalOn(goals, today), weighIns };
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
