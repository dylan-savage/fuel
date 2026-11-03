/**
 * The phone's working copy and the only module that imports Dexie. One table per kind,
 * derived from KINDS, plus the outbox and a meta row. Screens never import this file: they
 * read through views.ts and write through intents.ts, and sync.ts alone holds the SyncPort.
 */
import Dexie, { liveQuery } from 'dexie';
import type { Gtin } from '../domain/food.js';
import { addDays, type LocalDate, type SessionId } from '../domain/ids.js';
import {
  BARCODE_INDEX,
  DB_VERSION,
  KIND_NAMES,
  LIFT_DATE_INDEX,
  PLANNED_DATE_INDEX,
  SESSION_INDEX,
  dexieStores,
  parseDoc,
  type DatedKind,
  type DocOf,
  type Kind,
  type Mutation,
} from '../domain/kinds.js';
import type { LiftId } from '../domain/lifts.js';
import { programId } from '../domain/program.js';
import { ClientId, DocRecord, MutationId, Rev, type SyncReply, type SyncRequest, type WireMutation } from '../protocol.js';
import { BUILD } from './build.js';

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
  /**
   * The lowest rev this shell could not read, and the build that could not. Absent when
   * nothing waits to be read again, as on every row from before skipping existed.
   */
  readonly skipped?: { readonly build: string; readonly rev: Rev };
}

export interface ReplicaReader {
  get<K extends Kind>(kind: K, id: string): Promise<DocOf<K> | undefined>;
  onDate<K extends DatedKind>(kind: K, date: LocalDate): Promise<DocOf<K>[]>;
  /** Dated documents from `from` through `to`. */
  between<K extends DatedKind>(kind: K, from: LocalDate, to: LocalDate): Promise<DocOf<K>[]>;
  all<K extends Kind>(kind: K): Promise<DocOf<K>[]>;
  /** Library foods carrying this barcode, through the multi-entry index. */
  withBarcode(gtin: Gtin): Promise<DocOf<'food'>[]>;
  /** The version in effect. Program ids sort by date, so this seeks the primary key and scans nothing. */
  programOn(date: LocalDate): Promise<DocOf<'program'> | undefined>;
  /**
   * One seek per lift for its newest date before `before`. Every row of that date comes back,
   * because lastTimeOf breaks a tie by set time. The bound is the closed day before: a live
   * query treats an open bound as closed, so a set logged on `before` would re-run it.
   */
  lastPerformances(liftIds: readonly LiftId[], before: LocalDate): Promise<DocOf<'performance'>[]>;
  /** The same seek over planned lifts, so only swaps answer. */
  lastSwaps(liftIds: readonly LiftId[], before: LocalDate): Promise<DocOf<'performance'>[]>;
  performancesOfSession(sessionId: SessionId): Promise<DocOf<'performance'>[]>;
  /** These lifts from `from` on, plus what was done as a swap for them, which a chart draws as a tick. */
  performancesFrom(liftIds: readonly LiftId[], from: LocalDate): Promise<DocOf<'performance'>[]>;
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
  /**
   * The oldest `limit` outbox rows with the cursor and epoch to pull from. A build other
   * than the one that skipped records pulls from just before the lowest of them.
   */
  nextBatch(limit: number): Promise<SyncRequest>;
  /**
   * Applies one response in one transaction. Pulled changes are skipped for documents with
   * a pending outbox row: every mutation is a whole document, and the pending one reaches
   * the server after everything already pulled, so it wins there too.
   *
   * A new server epoch means the database was restored from a backup, which may hold
   * older versions of what this phone has. The phone re-queues every document it holds,
   * so its copy wins and anything the backup lacks is restored. Deletes made after the
   * backup come back, because the phone keeps no tombstones. A document whose newer version
   * this shell skipped goes back as the older copy it holds.
   *
   * A record this shell cannot read, of a kind it does not know or a document its schema
   * rejects, is skipped and remembered in the meta row. The rest of the response applies
   * as usual, and a local copy of that document stays as it is. Applying a response pulled
   * under a new build or from a restored server replaces what was remembered.
   *
   * Applying the same response twice changes nothing.
   */
  apply(res: SyncReply): Promise<void>;
  pendingCount(): Promise<number>;
}

export interface ReplicaOptions {
  readonly name?: string;
  /** fake-indexeddb in tests. */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
  readonly newId?: () => string;
  /** Tests open one database under two values to stand in for an update. */
  readonly build?: string;
}

/** A local write its kind's schema rejects. */
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

const RecordRev = DocRecord.pick({ rev: true });

export async function openReplica(options: ReplicaOptions = {}): Promise<{ replica: Replica; port: SyncPort }> {
  const { name = 'fuel', indexedDB, IDBKeyRange, newId = () => crypto.randomUUID(), build = BUILD } = options;
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

  // Derived rather than stored, so a lost response or a crash rewinds again until one applies.
  const pullFrom = ({ cursor, skipped }: SyncMeta): Rev =>
    skipped === undefined || skipped.build === build ? cursor : Rev.parse(Math.max(0, Math.min(cursor, skipped.rev - 1)));

  const newestBefore = async (index: string, liftIds: readonly LiftId[], before: LocalDate) => {
    const perLift = liftIds.map((lift) => {
      let newest: LocalDate | undefined;
      return table('performance')
        .where(index)
        .between([lift, Dexie.minKey], [lift, addDays(before, -1)], true, true)
        .reverse()
        .until((row) => row.doc.date !== (newest ??= row.doc.date))
        .toArray();
    });
    return (await Promise.all(perLift)).flat().map((row) => row.doc);
  };

  const fromDate = (index: string, liftIds: readonly LiftId[], from: LocalDate) =>
    liftIds.map((lift) => table('performance').where(index).between([lift, from], [lift, Dexie.maxKey], true, true).toArray());

  const read: ReplicaReader = {
    get: async (kind, id) => (await table(kind).get(id))?.doc,
    onDate: async (kind, date) => (await table(kind).where('doc.date').equals(date).toArray()).map((row) => row.doc),
    between: async (kind, from, to) =>
      (await table(kind).where('doc.date').between(from, to, true, true).toArray()).map((row) => row.doc),
    all: async (kind) => (await table(kind).toArray()).map((row) => row.doc),
    withBarcode: async (gtin) => (await table('food').where(BARCODE_INDEX).equals(gtin).toArray()).map((row) => row.doc),
    programOn: async (date) => (await table('program').where('id').belowOrEqual(programId(date)).last())?.doc,
    lastPerformances: (liftIds, before) => newestBefore(LIFT_DATE_INDEX, liftIds, before),
    lastSwaps: (liftIds, before) => newestBefore(PLANNED_DATE_INDEX, liftIds, before),
    performancesOfSession: async (sessionId) => (await table('performance').where(SESSION_INDEX).equals(sessionId).toArray()).map((row) => row.doc),
    performancesFrom: async (liftIds, from) => {
      const rows = await Promise.all([...fromDate(LIFT_DATE_INDEX, liftIds, from), ...fromDate(PLANNED_DATE_INDEX, liftIds, from)]);
      return [...new Map(rows.flat().map((row) => [row.id, row.doc])).values()];
    },
    pendingCount: () => outbox.count(),
  };

  /**
   * Null when the schema of this shell rejects the document, writing nothing. Not async, so a
   * rejection awaits nothing: Dexie loses its transaction after 100 native awaits with no
   * IndexedDB work between them, which a long run of rejections would otherwise be.
   */
  const writeRecord = (record: DocRecord): Promise<unknown> | null => {
    if (record.doc === null) return table(record.kind).delete(record.id);
    const parsed = parseDoc(record.kind, record.doc);
    return parsed.ok ? table(record.kind).put({ id: record.id, doc: parsed.doc }) : null;
  };

  const listeners = new Set<() => void>();

  const replica: Replica = {
    read,
    commit: async (mutations) => {
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
        const current = await readMeta();
        const rows = await outbox.orderBy('mutationId').limit(limit).toArray();
        const mutations = rows.map((row): WireMutation => {
          const id = MutationId.parse(row.mutationId);
          return row.op === 'put'
            ? { op: 'put', id, kind: row.kind, docId: row.docId, doc: row.doc }
            : { op: 'delete', id, kind: row.kind, docId: row.docId };
        });
        return { clientId: current.clientId, epoch: current.epoch, cursor: pullFrom(current), mutations, build };
      }),

    apply: (res) =>
      db.transaction('rw', [...kindTables, outbox, meta], async () => {
        const current = await readMeta();
        await outbox.where('mutationId').belowOrEqual(res.lastMutationId).delete();
        const pending = new Set((await outbox.toArray()).map((row) => docKey(row.kind, row.docId)));
        const restored = current.epoch !== null && current.epoch !== res.epoch;

        if (restored) {
          for (const kind of KIND_NAMES) {
            for (const row of await table(kind).toArray()) {
              if (pending.has(docKey(kind, row.id))) continue;
              await outbox.add({ op: 'put', kind, docId: row.id, doc: row.doc });
              pending.add(docKey(kind, row.id));
            }
          }
        }

        const unread: number[] = !restored && current.skipped?.build === build ? [current.skipped.rev] : [];
        for (const rejection of res.rejected) {
          if (pending.has(docKey(rejection.kind, rejection.docId))) continue;
          if (rejection.current === null) {
            await table(rejection.kind).delete(rejection.docId);
            continue;
          }
          const write = writeRecord(rejection.current);
          if (write === null) unread.push(rejection.current.rev);
          else await write;
        }
        const pulledFrom = restored ? 0 : pullFrom(current);
        for (const raw of res.changes) {
          const record = DocRecord.safeParse(raw);
          if (record.success) {
            if (pending.has(docKey(record.data.kind, record.data.id))) continue;
            const write = writeRecord(record.data);
            if (write === null) unread.push(record.data.rev);
            else await write;
          } else {
            const found = RecordRev.safeParse(raw);
            unread.push(found.success ? found.data.rev : pulledFrom + 1);
          }
        }

        const skipped = unread.length === 0 ? {} : { skipped: { build, rev: Rev.parse(Math.min(...unread)) } };
        await meta.put({ key: current.key, clientId: current.clientId, epoch: res.epoch, cursor: res.cursor, ...skipped });
      }),

    pendingCount: () => outbox.count(),
  };

  return { replica, port };
}
