#!/usr/bin/env node
// The coach's tool. Fetch and argv only, with nothing from dist/ or src/, so a deploy under way
// looks like connection refused rather than a crash.
//
//   node scripts/train.mjs read                     writes snapshot.json and draft.json
//   node scripts/train.mjs publish <file> [--dry-run]
//   node scripts/train.mjs status
//
// Prints one JSON line. Exit 0 landed or unchanged (or a clean dry run), 1 anything unexpected,
// 2 invalid, 3 frozen or stale, 4 unreachable, 5 phone behind.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const BASE_URL = process.env.FUEL_URL || 'http://127.0.0.1:8787';

const EXIT_UNEXPECTED = 1;
const EXIT_UNREACHABLE = 4;
const EXIT_PHONE_BEHIND = 5;

const RETRY_AFTER_MS = 1000;
const TIMEOUT_MS = 30_000;

/** What each publish answer must look like to count, so nothing else can exit 0. */
const PUBLISH_ANSWERS = {
  published: { http: 200, exit: 0, fields: ['id', 'rev'] },
  unchanged: { http: 200, exit: 0, fields: ['id', 'rev'] },
  'dry-run': { http: 200, exit: 0, fields: ['id', 'diff'] },
  invalid: { http: 422, exit: 2, fields: ['problems'] },
  frozen: { http: 409, exit: 3, fields: ['id', 'earliestEffectiveFrom'] },
  stale: { http: 409, exit: 3, fields: ['currentRev'] },
  phone_behind: { http: 409, exit: EXIT_PHONE_BEHIND, fields: [] },
};

function finish(exit, line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exitCode = exit;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Null when the server cannot be reached. Retries once, which a publish can afford because a repeat answers unchanged. */
async function ask(path, init = {}) {
  const url = new URL(path, BASE_URL);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, RETRY_AFTER_MS));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { http: res.status, body: parsed(await res.text()) };
    } catch {
      // A network error or timeout, including a connection lost partway through the answer.
    }
  }
  return null;
}

const unreachable = () => finish(EXIT_UNREACHABLE, { status: 'unreachable', url: BASE_URL });
const unexpected = (answer) => finish(EXIT_UNEXPECTED, { status: 'unexpected', http: answer.http });

/** The checkout holding this directory, by the real path of whatever part of it exists yet. */
function checkoutHolding(dir) {
  let existing = dir;
  while (!existsSync(existing)) existing = dirname(existing);
  for (let at = realpathSync(existing); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return null;
  }
}

async function read() {
  const dir = resolve(process.env.FUEL_COACH_DIR || join(homedir(), 'Library/Application Support/fuel/coach'));
  const checkout = checkoutHolding(dir);
  if (checkout !== null) return finish(EXIT_UNEXPECTED, { status: 'refused', dir, reason: `inside the git checkout at ${checkout}, and this holds real data` });

  const answer = await ask('/api/train/snapshot');
  if (answer === null) return unreachable();
  const snapshot = answer.body;
  if (answer.http !== 200 || !isObject(snapshot) || typeof snapshot.basedOnRev !== 'number' || !('draft' in snapshot)) return unexpected(answer);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const snapshotFile = join(dir, 'snapshot.json');
  const draftFile = join(dir, 'draft.json');
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(draftFile, `${JSON.stringify({ basedOnRev: snapshot.basedOnRev, ...snapshot.draft }, null, 2)}\n`, { mode: 0o600 });
  return finish(0, { status: 'read', snapshot: snapshotFile, draft: draftFile, basedOnRev: snapshot.basedOnRev });
}

async function publish(file, dryRun) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return finish(EXIT_UNEXPECTED, { status: 'unreadable', file, reason: err.code ?? 'unknown' });
  }
  // The bytes go as they are, so the deployed schema is the only judge of them.
  const answer = await ask(`/api/train/publish${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  if (answer === null) return unreachable();
  const { body } = answer;
  const known = isObject(body) && Object.hasOwn(PUBLISH_ANSWERS, body.status) ? PUBLISH_ANSWERS[body.status] : null;
  if (known === null || known.http !== answer.http || !known.fields.every((field) => field in body)) return unexpected(answer);
  return finish(known.exit, body);
}

async function status() {
  const answer = await ask('/healthz');
  if (answer === null) return unreachable();
  const { body } = answer;
  if (answer.http !== 200 || !isObject(body) || body.ok !== true || !('phoneBuild' in body)) return unexpected(answer);
  return body.phoneBuild === null ? finish(EXIT_PHONE_BEHIND, { status: 'phone_behind', rev: body.rev }) : finish(0, { status: 'ready', rev: body.rev, phoneBuild: body.phoneBuild });
}

const USAGE = 'usage: train.mjs read | publish <file> [--dry-run] | status';

async function main() {
  const { values, positionals } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } }, allowPositionals: true });
  const [command, file, ...extra] = positionals;
  if (extra.length > 0) return finish(EXIT_UNEXPECTED, { status: 'usage', usage: USAGE });
  if (command === 'read' && file === undefined) return read();
  if (command === 'status' && file === undefined) return status();
  if (command === 'publish' && file !== undefined) return publish(file, values['dry-run']);
  return finish(EXIT_UNEXPECTED, { status: 'usage', usage: USAGE });
}

// A misspelled flag lands here rather than publishing for real.
await main().catch((err) => finish(EXIT_UNEXPECTED, { status: 'error', message: String(err.message ?? err) }));
