/**
 * Read models for screens and the hooks that serve them. Each view reads replica documents
 * and hands them to one pure domain function. useLive re-renders on local writes and sync
 * merges alike.
 */
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { summarizeDay, type DaySummary } from '../domain/diary.js';
import type { LocalDate } from '../domain/ids.js';
import type { Intents } from './intents.js';
import type { Replica, ReplicaReader, Subscribable } from './replica.js';
import type { SyncState } from './sync.js';

export async function dayView(r: ReplicaReader, date: LocalDate): Promise<DaySummary> {
  return summarizeDay(await r.onDate('entry', date));
}

/** Writes made on this phone that the mini has not acknowledged. */
export function waitingView(r: ReplicaReader): Promise<number> {
  return r.pendingCount();
}

/** Everything a screen may touch: live reads, intents and sync status. No commit, no outbox. */
export interface Fuel {
  readonly replica: Pick<Replica, 'live'>;
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

export function useIntents(): Intents {
  return useFuel().intents;
}

export function useSyncState(): SyncState | undefined {
  const { sync } = useFuel();
  const [state, setState] = useState<SyncState>();
  useEffect(() => sync.subscribe(setState), [sync]);
  return state;
}
