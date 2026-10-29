/**
 * The store of record and the only module that imports better-sqlite3. Every kind lives in
 * one `doc` table, so a new kind needs no migration.
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { KindName, parseDoc } from '../domain/kinds.js';
import type { Millis } from '../domain/ids.js';
import { Rev, type DocRecord, type Rejection, type SyncRequest, type SyncResponse, type WireMutation } from '../protocol.js';

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
`;

export const PULL_PAGE = 1000;

export interface DocStore {
  /**
   * One round of the sync protocol in one IMMEDIATE transaction: apply the mutations this
   * client has not sent before, in order, then return everything above the cursor.
   * Replaying a request applies nothing twice, so a lost response is safe to retry.
   */
  sync(req: SyncRequest, ctx: { readonly now: Millis; readonly userAgent: string | null }): SyncResponse;
  stats(): { readonly epoch: string; readonly rev: Rev };
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
const MaxRow = z.object({ rev: Rev });
const MetaRow = z.object({ value: z.string() });

const ZERO = Rev.parse(0);

function toRecord(row: z.infer<typeof DocRow>): DocRecord {
  return { kind: row.kind, id: row.id, rev: row.rev, doc: row.body === null ? null : parseJson(row.body) };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
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
    maxRev: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM doc'),
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
  };

  const readEpoch = (): string => MetaRow.parse(q.epoch.get()).value;
  const readRev = (): Rev => MaxRow.parse(q.maxRev.get()).rev;

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

  return {
    sync: (req, ctx) => sync.immediate(req, ctx.now, ctx.userAgent),
    stats: () => ({ epoch: readEpoch(), rev: readRev() }),
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
