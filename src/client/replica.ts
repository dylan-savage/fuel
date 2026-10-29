/**
 * The phone's working copy and the only module that imports Dexie. One table per kind,
 * derived from KINDS, plus the outbox and a meta row. Screens never import this file: they
 * read through views.ts and write through intents.ts, and sync.ts alone holds the SyncPort.
 */
import Dexie, { liveQuery } from 'dexie';
import type { Gtin } from '../domain/food.js';
import type { LocalDate } from '../domain/ids.js';
import {
  BARCODE_INDEX,
  DB_VERSION,
  KIND_NAMES,
  dexieStores,
  parseDoc,
  type DatedKind,
  type DocOf,
  type Kind,
  type Mutation,
} from '../domain/kinds.js';
import {
  ClientId,
  MutationId,
  Rev,
  type DocRecord,
  type Rejection,
  type SyncRequest,
  type SyncResponse,
  type WireMutation,
} from '../protocol.js';

interface KindRow<D> {
  readonly id: string;
  readonly doc: D;
}

type OutboxEntry =
  | { readonly op: 'put'; readonly kind: Kind; readonly docId: string; readonly doc: unknown }
  | { readonly op: 'delete'; readonly kind: Kind; readonly docId: string };
type OutboxRow = OutboxEntry & { readonly mutationId: number };

interface SyncMeta {
  readonly key: 'sync';
  readonly clientId: ClientId;
  readonly epoch: string | null;
  readonly cursor: Rev;
}

export interface ReplicaReader {
  get<K extends Kind>(kind: K, id: string): Promise<DocOf<K> | undefined>;
  onDate<K extends DatedKind>(kind: K, date: LocalDate): Promise<DocOf<K>[]>;
  /** Dated documents from `from` through `to`. */
  between<K extends DatedKind>(kind: K, from: LocalDate, to: LocalDate): Promise<DocOf<K>[]>;
  all<K extends Kind>(kind: K): Promise<DocOf<K>[]>;
  /** Library foods carrying this barcode, through the multi-entry index. */
  withBarcode(gtin: Gtin): Promise<DocOf<'food'>[]>;
  /** Local writes the server has not acknowledged yet. */
  pendingCount(): Promise<number>;
}

export interface Subscribable<T> {
  subscribe(listener: (value: T) => void): () => void;
}

export interface Replica {
  readonly read: ReplicaReader;
  /**
   * Writes the documents and one outbox row per mutation in one IndexedDB transaction,
   * then tells onCommit listeners. Live queries re-run before any network activity, which
   * is what makes logging instant offline. Throws InvalidDocument, writing nothing, when a
   * document fails its kind's schema.
   */
  commit(mutations: readonly Mutation[]): Promise<void>;
  /** Re-runs the query whenever a table it read changes, from a commit or a sync merge. */
  live<T>(query: (r: ReplicaReader) => Promise<T>): Subscribable<T>;
  onCommit(listener: () => void): () => void;
  close(): void;
}

/** The replica's half of the sync protocol. Held only by sync.ts. */
export interface SyncPort {
  /** The oldest `limit` outbox rows with the cursor and epoch to pull from. */
  nextBatch(limit: number): Promise<SyncRequest>;
  /**
   * Applies one response in one transaction. Pulled changes are skipped for documents with
   * a pending outbox row: every mutation is a whole document, and the pending one reaches
   * the server after everything already pulled, so it wins there too.
   *
   * A new server epoch means the database was restored from a backup, which may hold
   * older versions of what this phone has. The phone re-queues every document it holds,
   * so its copy wins and anything the backup lacks is restored. Deletes made after the
   * backup come back, because the phone keeps no tombstones.
   *
   * Applying the same response twice changes nothing.
   */
  apply(res: SyncResponse): Promise<void>;
  pendingCount(): Promise<number>;
}

export interface ReplicaOptions {
  readonly name?: string;
  /** fake-indexeddb in tests. */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
  readonly newId?: () => string;
}

/** A local write its kind's schema rejects. Thrown by commit before anything is written. */
export class InvalidDocument extends Error {
  override readonly name = 'InvalidDocument';
  constructor(
    readonly kind: Kind,
    readonly id: string,
    readonly reason: string,
  ) {
    super(`refused to write ${kind} ${id}: ${reason}`);
  }
}

const docKey = (kind: Kind, id: string) => `${kind}\u0000${id}`;

export async function openReplica(options: ReplicaOptions = {}): Promise<{ replica: Replica; port: SyncPort }> {
  const { name = 'fuel', indexedDB, IDBKeyRange, newId = () => crypto.randomUUID() } = options;
  const db = new Dexie(name, indexedDB && IDBKeyRange ? { indexedDB, IDBKeyRange } : {});
  db.version(DB_VERSION).stores(dexieStores());

  const table = <K extends Kind>(kind: K) => db.table<KindRow<DocOf<K>>, string>(kind);
  const kindTables = KIND_NAMES.map((kind) => table(kind));
  const outbox = db.table<OutboxRow, number, OutboxEntry>('outbox');
  const meta = db.table<SyncMeta, 'sync'>('meta');

  await db.open();
  await db.transaction('rw', meta, async () => {
    if ((await meta.get('sync')) !== undefined) return;
    await meta.put({ key: 'sync', clientId: ClientId.parse(newId()), epoch: null, cursor: Rev.parse(0) });
  });

  const readMeta = async (): Promise<SyncMeta> => {
    const row = await meta.get('sync');
    if (row === undefined) throw new Error('replica meta row missing');
    return row;
  };

  const read: ReplicaReader = {
    get: async (kind, id) => (await table(kind).get(id))?.doc,
    onDate: async (kind, date) => (await table(kind).where('doc.date').equals(date).toArray()).map((row) => row.doc),
    between: async (kind, from, to) =>
      (await table(kind).where('doc.date').between(from, to, true, true).toArray()).map((row) => row.doc),
    all: async (kind) => (await table(kind).toArray()).map((row) => row.doc),
    withBarcode: async (gtin) => (await table('food').where(BARCODE_INDEX).equals(gtin).toArray()).map((row) => row.doc),
    pendingCount: () => outbox.count(),
  };

  const writeRecord = async (record: DocRecord): Promise<void> => {
    if (record.doc === null) {
      await table(record.kind).delete(record.id);
      return;
    }
    const parsed = parseDoc(record.kind, record.doc);
    // A shell older than the server it talks to. Failing loudly keeps the outbox intact
    // until the service worker update lands, instead of silently dropping a document.
    if (!parsed.ok) throw new Error(`server sent a ${record.kind} this app cannot read: ${parsed.reason}`);
    await table(record.kind).put({ id: record.id, doc: parsed.doc });
  };

  const undoRejection = async (rejection: Rejection): Promise<void> => {
    if (rejection.current === null) await table(rejection.kind).delete(rejection.docId);
    else await writeRecord(rejection.current);
  };

  const listeners = new Set<() => void>();

  const replica: Replica = {
    read,
    commit: async (mutations) => {
      // The mini would reject the document and sync would then delete it from the phone, long
      // after the edit. Refusing it here makes the edit itself fail, with nothing written.
      for (const m of mutations) {
        if (m.op !== 'put') continue;
        const parsed = parseDoc(m.kind, m.doc);
        if (!parsed.ok) throw new InvalidDocument(m.kind, m.doc.id, parsed.reason);
      }
      await db.transaction('rw', [...kindTables, outbox], async () => {
        for (const m of mutations) {
          if (m.op === 'put') {
            await table(m.kind).put({ id: m.doc.id, doc: m.doc });
            await outbox.add({ op: 'put', kind: m.kind, docId: m.doc.id, doc: m.doc });
          } else {
            await table(m.kind).delete(m.id);
            await outbox.add({ op: 'delete', kind: m.kind, docId: m.id });
          }
        }
      });
      for (const listener of listeners) listener();
    },
    live: (query) => ({
      subscribe: (listener) => {
        const subscription = liveQuery(() => query(read)).subscribe({
          next: listener,
          error: (err: unknown) => console.error('live query failed', err),
        });
        return () => subscription.unsubscribe();
      },
    }),
    onCommit: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => db.close(),
  };

  const port: SyncPort = {
    nextBatch: (limit) =>
      db.transaction('r', [outbox, meta], async () => {
        const { clientId, epoch, cursor } = await readMeta();
        const rows = await outbox.orderBy('mutationId').limit(limit).toArray();
        const mutations = rows.map((row): WireMutation => {
          const id = MutationId.parse(row.mutationId);
          return row.op === 'put'
            ? { op: 'put', id, kind: row.kind, docId: row.docId, doc: row.doc }
            : { op: 'delete', id, kind: row.kind, docId: row.docId };
        });
        return { clientId, epoch, cursor, mutations };
      }),

    apply: (res) =>
      db.transaction('rw', [...kindTables, outbox, meta], async () => {
        const current = await readMeta();
        await outbox.where('mutationId').belowOrEqual(res.lastMutationId).delete();
        const pending = new Set((await outbox.toArray()).map((row) => docKey(row.kind, row.docId)));

        if (current.epoch !== null && current.epoch !== res.epoch) {
          for (const kind of KIND_NAMES) {
            for (const row of await table(kind).toArray()) {
              if (pending.has(docKey(kind, row.id))) continue;
              await outbox.add({ op: 'put', kind, docId: row.id, doc: row.doc });
              pending.add(docKey(kind, row.id));
            }
          }
        }

        for (const rejection of res.rejected) {
          if (!pending.has(docKey(rejection.kind, rejection.docId))) await undoRejection(rejection);
        }
        for (const change of res.changes) {
          if (!pending.has(docKey(change.kind, change.id))) await writeRecord(change);
        }

        await meta.put({ ...current, epoch: res.epoch, cursor: res.cursor });
      }),

    pendingCount: () => outbox.count(),
  };

  return { replica, port };
}
