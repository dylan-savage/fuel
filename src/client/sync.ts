/**
 * When to sync, retries and single flight. The protocol rules live in SyncPort.apply and
 * DocStore.sync; this file decides timing only.
 */
import { Millis } from '../domain/ids.js';
import { MAX_PUSH, SyncReply, type SyncRequest } from '../protocol.js';
import type { Replica, Subscribable, SyncPort } from './replica.js';

export type SyncState =
  | { readonly kind: 'idle'; readonly lastSyncedAt: Millis | null }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'offline'; readonly retryAt: Millis }
  | { readonly kind: 'error'; readonly message: string; readonly retryAt: Millis };

/** Sends one request to the server and returns its parsed response. */
export type Transport = (req: SyncRequest) => Promise<SyncReply>;

/** The mini could not be reached at all, as opposed to answering with an error. */
export class OfflineError extends Error {}

export function httpTransport(url = '/api/sync'): Transport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    } catch (err) {
      throw new OfflineError(String(err));
    }
    if (!res.ok) throw new Error(`sync answered ${res.status}`);
    return SyncReply.parse(await res.json());
  };
}

const MAX_ROUNDS = 20;

/** Push and pull until the outbox is empty and nothing is left to pull, or MAX_ROUNDS. */
export async function syncRounds(port: SyncPort, transport: Transport, batch = MAX_PUSH): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const req = await port.nextBatch(batch);
    const res = await transport(req);
    await port.apply(res);
    if (!res.more && (await port.pendingCount()) === 0) return;
  }
}

export interface SyncHandle {
  readonly state: Subscribable<SyncState>;
  /** Sync soon. Called after every commit, debounced. */
  poke(): void;
  /** Sync now, joining a run already in flight. */
  run(): Promise<void>;
  stop(): void;
}

export interface SyncOptions {
  readonly transport?: Transport;
  /** Where 'online' fires. */
  readonly window?: EventTarget;
  /** Where 'visibilitychange' fires. */
  readonly document?: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  readonly locks?: LockManager;
  readonly now?: () => Millis;
  readonly debounceMs?: number;
  readonly intervalMs?: number;
  readonly backoffMs?: { readonly base: number; readonly max: number };
}

/**
 * iOS gives Home Screen web apps no background sync, so this runs only while the app is
 * open: at start, after commits, on returning to the foreground, on 'online', and every
 * intervalMs while visible. Failures change no data and retry with exponential backoff.
 */
export function startSync(port: SyncPort, replica: Pick<Replica, 'onCommit'>, options: SyncOptions = {}): SyncHandle {
  const {
    transport = httpTransport(),
    window: win = globalThis.window,
    document: doc = globalThis.document,
    locks = globalThis.navigator?.locks,
    now = () => Millis.parse(Date.now()),
    debounceMs = 300,
    intervalMs = 60_000,
    backoffMs = { base: 2_000, max: 300_000 },
  } = options;

  let state: SyncState = { kind: 'idle', lastSyncedAt: null };
  const listeners = new Set<(s: SyncState) => void>();
  const setState = (next: SyncState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let stopped = false;

  // Two tabs of the app share one IndexedDB; the lock keeps their rounds from interleaving.
  const exclusive = (work: () => Promise<void>): Promise<void> =>
    locks ? locks.request('fuel-sync', work) : work();

  const attempt = async () => {
    clearTimeout(retryTimer);
    setState({ kind: 'syncing' });
    try {
      await exclusive(() => syncRounds(port, transport));
      failures = 0;
      setState({ kind: 'idle', lastSyncedAt: now() });
    } catch (err) {
      failures += 1;
      const delay = Math.min(backoffMs.max, backoffMs.base * 2 ** (failures - 1));
      const retryAt = Millis.parse(now() + delay);
      if (!stopped) retryTimer = setTimeout(() => void run(), delay);
      setState(
        err instanceof OfflineError
          ? { kind: 'offline', retryAt }
          : { kind: 'error', message: err instanceof Error ? err.message : String(err), retryAt },
      );
    }
  };

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        rerun = false;
        await attempt();
      } while (rerun && !stopped);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const poke = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void run(), debounceMs);
  };

  const onOnline = () => void run();
  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') void run();
  };
  win?.addEventListener('online', onOnline);
  doc?.addEventListener('visibilitychange', onVisibility);
  const offCommit = replica.onCommit(poke);
  const interval = setInterval(() => {
    if (!doc || doc.visibilityState === 'visible') void run();
  }, intervalMs);
  void run();

  return {
    state: {
      subscribe: (listener) => {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
      },
    },
    poke,
    run,
    stop: () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(debounceTimer);
      clearInterval(interval);
      win?.removeEventListener('online', onOnline);
      doc?.removeEventListener('visibilitychange', onVisibility);
      offCommit();
    },
  };
}
