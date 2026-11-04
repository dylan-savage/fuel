#!/usr/bin/env node
// The Notion import's tool. Fetch and argv only, like scripts/train.mjs, and deleted at cutover
// with src/server/import.ts. It goes to FUEL_URL, or the live server when that is unset.
//
//   node scripts/import-history.mjs <file> [--dry-run] [--weigh-ins]
//
// Prints one JSON line. Exit 0 landed (or a clean dry run), 1 anything unexpected, 2 invalid,
// unreconciled or past cutover, 3 the rest landed with conflicts listed, 4 unreachable, 5 phone behind.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const BASE_URL = process.env.FUEL_URL || 'http://127.0.0.1:8787';

const EXIT_UNEXPECTED = 1;
const EXIT_CONFLICTS = 3;
const EXIT_UNREACHABLE = 4;
const EXIT_PHONE_BEHIND = 5;

const RETRY_AFTER_MS = 1000;
const TIMEOUT_MS = 30_000;

const LANDED_FIELDS = ['digest', 'written', 'unchanged', 'conflicts', 'orphans', 'weighIns'];

/** What each answer must look like to count, so nothing else can exit 0. */
const ANSWERS = {
  imported: { http: 200, exit: 0, fields: LANDED_FIELDS },
  'dry-run': { http: 200, exit: 0, fields: [...LANDED_FIELDS, 'phoneBehind', 'targetShift'] },
  invalid: { http: 422, exit: 2, fields: ['problems'] },
  unreconciled: { http: 422, exit: 2, fields: ['standing', 'staleWaivers'] },
  past_cutover: { http: 422, exit: 2, fields: ['cutover', 'dates'] },
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

/** Null when the server cannot be reached. Retries once, which an import can afford because a repeat writes nothing new. */
async function ask(path, init) {
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

function queryOf({ dryRun, weighIns }) {
  const flags = [...(dryRun ? ['dryRun=1'] : []), ...(weighIns ? ['weighIns=1'] : [])];
  return flags.length === 0 ? '' : `?${flags.join('&')}`;
}

async function run(file, flags) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return finish(EXIT_UNEXPECTED, { status: 'unreadable', file, reason: err.code ?? 'unknown' });
  }
  // The bytes go as they are, so the deployed schema is the only judge of them.
  const answer = await ask(`/api/train/import${queryOf(flags)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  if (answer === null) return finish(EXIT_UNREACHABLE, { status: 'unreachable', url: BASE_URL });
  const { body } = answer;
  const known = isObject(body) && Object.hasOwn(ANSWERS, body.status) ? ANSWERS[body.status] : null;
  if (known === null || known.http !== answer.http || !known.fields.every((field) => field in body)) return finish(EXIT_UNEXPECTED, { status: 'unexpected', http: answer.http });
  return finish(Array.isArray(body.conflicts) && body.conflicts.length > 0 ? EXIT_CONFLICTS : known.exit, body);
}

const USAGE = 'usage: import-history.mjs <file> [--dry-run] [--weigh-ins]';

async function main() {
  const { values, positionals } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, 'weigh-ins': { type: 'boolean', default: false } }, allowPositionals: true });
  const [file, ...extra] = positionals;
  if (file === undefined || extra.length > 0) return finish(EXIT_UNEXPECTED, { status: 'usage', usage: USAGE });
  return run(file, { dryRun: values['dry-run'], weighIns: values['weigh-ins'] });
}

// A misspelled flag lands here rather than importing for real.
await main().catch((err) => finish(EXIT_UNEXPECTED, { status: 'error', message: String(err.message ?? err) }));
