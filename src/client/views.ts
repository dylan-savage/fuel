/**
 * Read models for screens and the hooks that serve them. Each view reads replica documents
 * and hands them to pure domain functions. useLive re-renders on local writes and sync
 * merges alike.
 */
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { summarizeDay, type DaySummary } from '../domain/diary.js';
import type { Food, Gtin } from '../domain/food.js';
import { PROFILE_ID, budgetOn, goalOn, type Budget, type Goal, type Profile } from '../domain/goals.js';
import { addDays, type LocalDate, type Millis } from '../domain/ids.js';
import { RECENT_DAYS, recents, type RecentFood } from '../domain/library.js';
import type { Intents } from './intents.js';
import type { Replica, ReplicaReader, Subscribable } from './replica.js';
import type { SyncState } from './sync.js';

export interface DayView {
  readonly summary: DaySummary;
  /** Null before any goal, or while a computed goal has no profile. */
  readonly budget: Budget | null;
}

export async function dayView(r: ReplicaReader, date: LocalDate): Promise<DayView> {
  const [entries, goals, profile] = await Promise.all([r.onDate('entry', date), r.all('goal'), r.get('profile', PROFILE_ID)]);
  return { summary: summarizeDay(entries), budget: budgetOn({ goals, profile, date }) };
}

/** Every food logged in the last RECENT_DAYS, most used first. */
export async function recentsView(r: ReplicaReader, at: { readonly today: LocalDate; readonly now: Millis }): Promise<RecentFood[]> {
  const [entries, foods] = await Promise.all([r.between('entry', addDays(at.today, -RECENT_DAYS), at.today), r.all('food')]);
  return recents({ entries, library: new Map(foods.map((f) => [f.id, f])), now: at.now, limit: Number.POSITIVE_INFINITY });
}

export function libraryView(r: ReplicaReader): Promise<Food[]> {
  return r.all('food');
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
}

export async function goalView(r: ReplicaReader, today: LocalDate): Promise<GoalView> {
  const [profile, goals] = await Promise.all([r.get('profile', PROFILE_ID), r.all('goal')]);
  return { profile, goal: goalOn(goals, today) };
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
