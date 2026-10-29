/**
 * The phone's working copy: one Dexie (IndexedDB) table per kind, derived from KINDS, plus
 * the outbox and meta tables. The only module that imports Dexie. Screens read through
 * ReplicaReader and write through client/intents.ts. The SyncPort is returned separately
 * by openReplica and handed straight to startSync in main.tsx, so no screen can reach it.
 *
 * Stored row per kind: { id, rev: number | null, doc }. rev null = written here and not yet
 * echoed back by the server.
 * outbox row: { mutationId, kind, docId, doc | null, createdAt }.
 * meta rows: clientId, nextMutationId, cursor, epoch, reseedPending.
 */
import { todo } from '../todo.js';
import type { Food } from '../domain/food.js';
import type { Gtin, LocalDate } from '../domain/ids.js';
import type { ClientKind, DatedKind, DocOf, Kind } from '../domain/kinds.js';
import type { Rejection, SyncRequest, SyncResponse } from '../protocol.js';

/** A whole-document write. Only client-writable kinds are expressible, so the phone cannot even build a Health write. */
export type Change = {
  [K in ClientKind]: { readonly kind: K; readonly put: DocOf<K> } | { readonly kind: K; readonly del: string };
}[ClientKind];

export interface ReplicaReader {
  get<K extends Kind>(kind: K, id: string): Promise<DocOf<K> | undefined>;
  onDate<K extends DatedKind>(kind: K, date: LocalDate): Promise<DocOf<K>[]>;
  between<K extends DatedKind>(kind: K, from: LocalDate, to: LocalDate): Promise<DocOf<K>[]>;
  all<K extends Kind>(kind: K): Promise<DocOf<K>[]>;
  /** Local barcode index, so a scanned known product logs with no network. */
  foodByBarcode(gtin: Gtin): Promise<Food | undefined>;
}

export interface Subscribable<T> {
  subscribe(listener: (value: T) => void): () => void;
}

export interface Replica {
  readonly read: ReplicaReader;

  /**
   * Writes the docs (rev null) and one outbox row per change, with consecutive mutation
   * ids, in a single IndexedDB transaction, then notifies onCommit listeners. Live queries
   * re-run before any network activity, which is what makes logging instant offline.
   */
  commit(changes: readonly Change[]): Promise<void>;

  /** Dexie liveQuery underneath: re-runs when any table the query read changes, from a commit or a sync merge. */
  live<T>(query: (r: ReplicaReader) => Promise<T>): Subscribable<T>;

  onCommit(listener: () => void): () => void;
}

/** The replica's half of the sync protocol. Held only by client/sync.ts. */
export interface SyncPort {
  /** clientId, epoch, cursor and the oldest `limit` outbox rows as wire mutations. */
  nextBatch(limit: number): Promise<SyncRequest>;

  /**
   * Applies one response in one IndexedDB transaction:
   * 1. If res.epoch differs from meta.epoch: set every row's rev to null, set
   *    reseedPending, and treat this as page 1 of a full pull.
   * 2. Delete outbox rows with mutationId <= res.lastMutationId.
   * 3. For each rejection, write `current` (or delete the row when null), unless a newer
   *    outbox row for the same doc is still pending.
   * 4. For each change, skip it when an outbox row for (kind, id) is still pending: that
   *    pending write reaches the server later and wins there by arrival order, so keeping
   *    it locally is exactly what the server will end up with. Otherwise write
   *    { id, rev, doc } or delete on tombstone.
   * 5. Store cursor and epoch.
   * 6. When reseedPending and !res.more: every row still at rev null with no pending outbox
   *    row exists here but not on the restored server, so enqueue it as a put. Clear the flag.
   * Applying the same response twice is a no-op.
   */
  apply(res: SyncResponse): Promise<{ readonly rejected: readonly Rejection[]; readonly pending: number }>;

  pendingCount(): Promise<number>;
}

/**
 * Opens (or creates) the 'fuel' database at CLIENT_DB_VERSION with dexieStores(), mints
 * clientId on first launch, and calls navigator.storage.persist().
 */
export function openReplica(name = 'fuel'): Promise<{ replica: Replica; port: SyncPort }> {
  return todo(`openReplica(${name})`);
}
