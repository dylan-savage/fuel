/**
 * The lever for this design: a deterministic simulation that proves the sync protocol
 * before any UI exists, and that a reviewer reruns after every protocol change.
 *
 * It drives N replicas (real client/replica.ts over fake-indexeddb) and one real server
 * store (server/store.ts over ':memory:') through seeded random schedules. The transport
 * between them is a function that can drop a request, drop a response, or deliver twice.
 *
 * Properties checked after a final fault-free sync of every replica:
 *  1. Convergence. Every replica's docs equal the server's live docs, kind by kind.
 *  2. Arrival order wins. For each doc, the surviving version is the one from the
 *     mutation the server processed last.
 *  3. Acknowledged writes survive. A mutation at or below a client's lastMutationId is
 *     reflected on the server unless a later-arriving write replaced the same doc.
 *  4. Idempotent push. Replaying any recorded SyncRequest changes no row and no rev.
 *  5. Idempotent ingest. Resending any recorded Shortcut payload, in any order, changes no rev.
 *  6. Single writer. No replica's outbox can hold a 'health' mutation (type-level), and a
 *     hand-built one is rejected without touching the doc.
 *  7. Restore. After 'restore-backup' (server rolled back, epoch regenerated), every doc a
 *     replica holds that the server lost comes back after one full sync.
 */
import { todo } from '../src/todo.js';
import type { Change } from '../src/client/replica.js';
import type { HealthIngestRequest } from '../src/protocol.js';

export type Fate = 'deliver' | 'drop-request' | 'drop-response' | 'deliver-twice';

export type SimStep =
  | { readonly kind: 'write'; readonly replica: number; readonly changes: readonly Change[] }
  | { readonly kind: 'sync'; readonly replica: number; readonly fate: Fate }
  | { readonly kind: 'shortcut'; readonly payload: HealthIngestRequest; readonly fate: Fate }
  | { readonly kind: 'backup' }
  | { readonly kind: 'restore-backup' };

export interface SimConfig {
  readonly seed: number;
  readonly replicas: number;
  readonly steps: number;
}

export interface SimReport {
  readonly schedule: readonly SimStep[];
  /** Empty when every property held. Each failure names the property and the step index. */
  readonly failures: readonly string[];
}

/** Generates a schedule from the seed (fast-check arbitrary underneath) and runs it. */
export function runSim(config: SimConfig): Promise<SimReport> {
  return todo(`runSim(${config.seed}, ${config.replicas}, ${config.steps})`);
}
