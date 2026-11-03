/**
 * The store of record and the only module that imports better-sqlite3. Every kind lives in
 * one `doc` table, so a new kind needs no migration.
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Arrived } from '../domain/coach.js';
import { KindName, parseDoc, type DocOf, type Kind } from '../domain/kinds.js';
import { Millis } from '../domain/ids.js';
import type { Program } from '../domain/program.js';
import { PhoneBuild, Rev, type DocRecord, type Rejection, type SyncRequest, type SyncResponse, type WireMutation } from '../protocol.js';

const SCHEMA_SQL = /* sql */ `
-- Every synced document of every kind. A delete keeps the row with body NULL and a new rev,
-- so a pull can tell other replicas about it.
CREATE TABLE IF NOT EXISTS doc (
  kind       TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  rev        INTEGER NOT NULL UNIQUE,
  body       TEXT,
  written_by TEXT    NOT NULL,
  written_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;

-- Push idempotency: a mutation id at or below last_mutation_id has been processed.
CREATE TABLE IF NOT EXISTS client (
  id               TEXT    PRIMARY KEY,
  last_mutation_id INTEGER NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  user_agent       TEXT
) STRICT;

-- Refused mutations, kept for debugging. Never read by sync.
CREATE TABLE IF NOT EXISTS rejection (
  client_id   TEXT    NOT NULL,
  mutation_id INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  reason      TEXT    NOT NULL,
  mutation    TEXT    NOT NULL,
  PRIMARY KEY (client_id, mutation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

-- Open Food Facts and USDA answers exactly as received (HTTP status and JSON body). They are
-- parsed on every read, so a parser fix reaches cached foods too.
CREATE TABLE IF NOT EXISTS lookup_cache (
  source     TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  PRIMARY KEY (source, key)
) STRICT;
`;

const PULL_PAGE = 1000;

/** An external source's raw answer and when it arrived. */
export interface CachedAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly fetchedAt: Millis;
}

/** One answer per (source, key); a put replaces the previous one. */
export interface LookupCache {
  get(source: string, key: string): CachedAnswer | null;
  put(source: string, key: string, answer: CachedAnswer): void;
}

export interface DocStore {
  readonly lookupCache: LookupCache;
  /**
   * One round of the sync protocol in one IMMEDIATE transaction: apply the mutations this
   * client has not sent before, in order, then return everything above the cursor.
   * Replaying a request applies nothing twice, so a lost response is safe to retry.
   */
  sync(req: SyncRequest, ctx: { readonly now: Millis; readonly userAgent: string | null }): SyncResponse;
  /** Live documents of one kind with the revs they arrived at, read through the deployed schema. */
  liveDocs<K extends Kind>(kind: K): readonly Arrived<DocOf<K>>[];
  /** The newest rev any document of this kind took, a tombstone's included. 0 when it has none. */
  highestRev(kind: Kind): Rev;
  /**
   * The coach's one write, in one IMMEDIATE transaction: the next rev by sync's rule, so a phone
   * pulls it like any other change, then an upsert and a read back. Its only parameter is a
   * program, so sessions and performances are out of its reach.
   */
  writeProgram(program: Program, ctx: { readonly now: Millis }): Arrived<Program>;
  stats(): { readonly epoch: string; readonly rev: Rev; readonly phoneBuild: PhoneBuild | null };
  /** Online backup to `destination`, safe while the server keeps writing. */
  backup(destination: string): Promise<void>;
  /**
   * Call after restoring this file from a backup. Phones holding the old epoch then pull
   * from 0 and push back whatever the restored database lacks.
   */
  rotateEpoch(): void;
  close(): void;
}

const DocRow = z.object({ kind: KindName, id: z.string(), rev: Rev, body: z.string().nullable() });
const ClientRow = z.object({ last_mutation_id: z.number().int().nonnegative() });
const LiveRow = z.object({ rev: Rev, body: z.string() });
const MaxRow = z.object({ rev: Rev });
const MetaRow = z.object({ value: z.string() });
const CacheRow = z.object({ fetched_at: Millis, status: z.number().int(), body: z.string() });

const ZERO = Rev.parse(0);

function toRecord(row: z.infer<typeof DocRow>): DocRecord {
  return { kind: row.kind, id: row.id, rev: row.rev, doc: row.body === null ? null : parseJson(row.body) };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** The message names no field of the document, because the route that logs it must not log training data. */
function readStored<K extends Kind>(kind: K, row: z.infer<typeof LiveRow>): Arrived<DocOf<K>> {
  const parsed = parseDoc(kind, parseJson(row.body));
  if (!parsed.ok) throw new Error(`the ${kind} stored at rev ${row.rev} does not parse`);
  return { doc: parsed.doc, rev: row.rev };
}

type Verdict = { readonly ok: true; readonly body: string | null } | { readonly ok: false; readonly reason: string };

function check(m: WireMutation): Verdict {
  if (m.op === 'delete') return { ok: true, body: null };
  const parsed = parseDoc(m.kind, m.doc);
  if (!parsed.ok) return parsed;
  if (parsed.doc.id !== m.docId) return { ok: false, reason: `doc.id ${parsed.doc.id} does not match docId ${m.docId}` };
  return { ok: true, body: JSON.stringify(parsed.doc) };
}

/** Opens or creates the database. `:memory:` works for tests. */
export function openStore(path: string, opts: { readonly pageSize?: number } = {}): DocStore {
  const pageSize = opts.pageSize ?? PULL_PAGE;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)").run(randomUUID());

  const q = {
    epoch: db.prepare("SELECT value FROM meta WHERE key = 'epoch'"),
    setEpoch: db.prepare("UPDATE meta SET value = ? WHERE key = 'epoch'"),
    phoneBuild: db.prepare("SELECT value FROM meta WHERE key = 'phone_build'"),
    setPhoneBuild: db.prepare(`
      INSERT INTO meta (key, value) VALUES ('phone_build', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
    maxRev: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM doc'),
    maxRevOfKind: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM doc WHERE kind = ?'),
    live: db.prepare('SELECT rev, body FROM doc WHERE kind = ? AND body IS NOT NULL ORDER BY rev'),
    client: db.prepare('SELECT last_mutation_id FROM client WHERE id = ?'),
    upsertClient: db.prepare(`
      INSERT INTO client (id, last_mutation_id, first_seen_at, last_seen_at, user_agent)
      VALUES (@id, @last, @now, @now, @userAgent)
      ON CONFLICT (id) DO UPDATE SET
        last_mutation_id = excluded.last_mutation_id,
        last_seen_at = excluded.last_seen_at,
        user_agent = excluded.user_agent`),
    upsertDoc: db.prepare(`
      INSERT INTO doc (kind, id, rev, body, written_by, written_at)
      VALUES (@kind, @id, @rev, @body, @writtenBy, @now)
      ON CONFLICT (kind, id) DO UPDATE SET
        rev = excluded.rev, body = excluded.body,
        written_by = excluded.written_by, written_at = excluded.written_at`),
    reject: db.prepare(`
      INSERT OR IGNORE INTO rejection (client_id, mutation_id, at, reason, mutation)
      VALUES (?, ?, ?, ?, ?)`),
    doc: db.prepare('SELECT kind, id, rev, body FROM doc WHERE kind = ? AND id = ?'),
    changes: db.prepare('SELECT kind, id, rev, body FROM doc WHERE rev > ? ORDER BY rev LIMIT ?'),
    cached: db.prepare('SELECT fetched_at, status, body FROM lookup_cache WHERE source = ? AND key = ?'),
    cache: db.prepare(`
      INSERT INTO lookup_cache (source, key, fetched_at, status, body)
      VALUES (@source, @key, @fetchedAt, @status, @body)
      ON CONFLICT (source, key) DO UPDATE SET
        fetched_at = excluded.fetched_at, status = excluded.status, body = excluded.body`),
  };

  const readEpoch = (): string => MetaRow.parse(q.epoch.get()).value;
  const readRev = (): Rev => MaxRow.parse(q.maxRev.get()).rev;
  const readPhoneBuild = (): PhoneBuild | null => {
    const row = q.phoneBuild.get();
    return row === undefined ? null : PhoneBuild.parse(parseJson(MetaRow.parse(row).value));
  };

  const sync = db.transaction((req: SyncRequest, now: Millis, userAgent: string | null): SyncResponse => {
    const known = q.client.get(req.clientId);
    let last = known === undefined ? 0 : ClientRow.parse(known).last_mutation_id;
    let rev: number = readRev();
    const refused: { mutation: WireMutation; reason: string }[] = [];

    for (const m of req.mutations) {
      if (m.id <= last) continue;
      const verdict = check(m);
      if (verdict.ok) {
        rev += 1;
        q.upsertDoc.run({ kind: m.kind, id: m.docId, rev, body: verdict.body, writtenBy: req.clientId, now });
      } else {
        q.reject.run(req.clientId, m.id, now, verdict.reason, JSON.stringify(m));
        refused.push({ mutation: m, reason: verdict.reason });
      }
      last = m.id;
    }
    q.upsertClient.run({ id: req.clientId, last, now, userAgent });
    if (req.build !== undefined) q.setPhoneBuild.run(JSON.stringify({ build: req.build, at: now } satisfies PhoneBuild));

    const epoch = readEpoch();
    const from = req.epoch === epoch ? req.cursor : ZERO;
    const rows = q.changes.all(from, pageSize + 1).map((row) => DocRow.parse(row));
    const more = rows.length > pageSize;
    const page = more ? rows.slice(0, pageSize) : rows;
    const rejected: Rejection[] = refused.map(({ mutation, reason }) => {
      const current = q.doc.get(mutation.kind, mutation.docId);
      return {
        mutationId: mutation.id,
        kind: mutation.kind,
        docId: mutation.docId,
        reason,
        current: current === undefined ? null : toRecord(DocRow.parse(current)),
      };
    });

    return {
      epoch,
      lastMutationId: last,
      rejected,
      changes: page.map(toRecord),
      cursor: page.at(-1)?.rev ?? from,
      more,
    };
  });

  const writeProgram = db.transaction((program: Program, now: Millis): Arrived<Program> => {
    q.upsertDoc.run({ kind: 'program', id: program.id, rev: readRev() + 1, body: JSON.stringify(program), writtenBy: 'coach', now });
    return readStored('program', LiveRow.parse(q.doc.get('program', program.id)));
  });

  const lookupCache: LookupCache = {
    get: (source, key) => {
      const found = q.cached.get(source, key);
      if (found === undefined) return null;
      const row = CacheRow.parse(found);
      return { status: row.status, body: parseJson(row.body), fetchedAt: row.fetched_at };
    },
    put: (source, key, { status, body, fetchedAt }) => {
      q.cache.run({ source, key, fetchedAt, status, body: JSON.stringify(body) });
    },
  };

  return {
    lookupCache,
    sync: (req, ctx) => sync.immediate(req, ctx.now, ctx.userAgent),
    liveDocs: (kind) => q.live.all(kind).map((row) => readStored(kind, LiveRow.parse(row))),
    highestRev: (kind) => MaxRow.parse(q.maxRevOfKind.get(kind)).rev,
    writeProgram: (program, ctx) => writeProgram.immediate(program, ctx.now),
    stats: () => ({ epoch: readEpoch(), rev: readRev(), phoneBuild: readPhoneBuild() }),
    backup: async (destination) => {
      await db.backup(destination);
    },
    rotateEpoch: () => {
      q.setEpoch.run(randomUUID());
    },
    close: () => {
      db.close();
    },
  };
}
