// Checks a Notion export against the set model, using the phone's own math. It writes to no
// database. Deleted at cutover with src/domain/notionImport.ts.
//
//   node scripts/reconcile-history.mjs .private/training/import/notion-history.json
//
// Prints counts and mismatches and writes reconcile-report.md beside the input. Exit 0 when
// nothing stands unwaived and no waiver is stale, 1 when something does, 2 when the file fails
// its schema or a document fails its own. .private/training/import/EXPORT.md says how the input
// is made.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runnerImport } from 'vite';

const domain = join(import.meta.dirname, '..', 'src', 'domain', 'notionImport.ts');

/** RFC 9562 version 5 layout, so a session id is a valid UUID that depends only on its seed. */
function uuidFrom(seed) {
  const hash = createHash('sha1').update(`fuel-notion-import:${seed}`).digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const path = process.argv[2];
if (path === undefined) refuse('usage: node scripts/reconcile-history.mjs <notion-history.json>');

const { module: importer } = await runnerImport(domain, { configFile: false, logLevel: 'silent' });
const parsed = importer.NotionHistory.safeParse(JSON.parse(readFileSync(path, 'utf8')));
if (!parsed.success) {
  refuse(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
}

const history = parsed.data;
const result = importer.reconcile(history);
let docs;
try {
  docs = importer.importDocs(history, uuidFrom);
} catch (error) {
  refuse(`a document failed its schema: ${error.message}`);
}
const digest = createHash('sha256').update(JSON.stringify(docs)).digest('hex');
const summary = importer.summaryOf({ history, result, docs, digest });

writeFileSync(join(dirname(path), 'reconcile-report.md'), `${summary}${importer.detailsOf(history, result)}`);
process.stdout.write(summary);
process.exit(result.clean ? 0 : 1);
