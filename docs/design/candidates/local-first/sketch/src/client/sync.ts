/**
 * Network policy for the replica: when to sync, retries, single flight. The protocol rules
 * live in SyncPort.apply and DocStore.sync; this file decides timing only.
 */
import { todo } from '../todo.js';
import type { Millis } from '../domain/ids.js';
import type { Replica, Subscribable, SyncPort } from './replica.js';

export type SyncState =
  | { readonly kind: 'idle'; readonly lastSyncedAt: Millis | null }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'offline'; readonly since: Millis }
  | { readonly kind: 'error'; readonly message: string; readonly retryAt: Millis };

export interface SyncStatus {
  readonly state: SyncState;
  /** Outbox rows not yet acknowledged. The UI shows "N waiting" when > 0 and offline. */
  readonly pending: number;
  /** Rejections from the last round, for a "1 change couldn't be saved" toast with the reason. */
  readonly lastRejections: readonly string[];
}

export interface SyncHandle {
  readonly status: Subscribable<SyncStatus>;
  /** Sync soon (debounced 300 ms). Called on every commit. */
  poke(): void;
  stop(): void;
}

/**
 * Starts the loop. Triggers: start, commit (debounced), visibilitychange to visible,
 * 'online', and every 60 s while visible. iOS has no Background Sync for PWAs, so nothing
 * runs while the app is closed; the outbox waits in IndexedDB until the next open.
 * Single flight via navigator.locks.request('fuel-sync') so two tabs never interleave.
 * One round: POST nextBatch(500); apply(res). Repeat while res.more or new outbox rows exist,
 * at most 20 rounds per trigger.
 * Network failure or 5xx: state offline or error, exponential backoff to 5 min, no data change.
 * A lost response is harmless because the server skips already-processed mutation ids.
 */
export function startSync(
  port: SyncPort,
  replica: Pick<Replica, 'onCommit'>,
  opts?: { fetch?: typeof fetch; now?: () => Millis },
): SyncHandle {
  return todo(`startSync(${typeof port}, ${typeof replica}, ${typeof opts})`);
}
