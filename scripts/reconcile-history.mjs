// Checks a Notion export against the set model, using the phone's own math. It writes to no
// database. Deleted at cutover with src/domain/notionImport.ts.
//
//   node scripts/reconcile-history.mjs .private/training/import/notion-history.json
//
// Prints counts and mismatches and writes reconcile-report.md beside the input. Exit 0 when
// nothing stands unwaived and no waiver is stale, 1 when something does, 2 when the file fails
// its schema or a document fails its own. .private/training/import/EXPORT.md says how the input
// is made.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runnerImport } from 'vite';

const src = join(import.meta.dirname, '..', 'src');

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const path = process.argv[2];
if (path === undefined) refuse('usage: node scripts/reconcile-history.mjs <notion-history.json>');

const { module: importer } = await runnerImport(join(src, 'domain', 'notionImport.ts'), { configFile: false, logLevel: 'silent' });
// The route's own ids and digest, so this report and an import of the same file name the same documents.
const { module: route } = await runnerImport(join(src, 'server', 'import.ts'), { configFile: false, logLevel: 'silent' });
const parsed = importer.NotionHistory.safeParse(JSON.parse(readFileSync(path, 'utf8')));
if (!parsed.success) {
  refuse(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
}

const history = parsed.data;
const result = importer.reconcile(history);
let docs;
try {
  docs = importer.importDocs(history, route.uuidFrom);
} catch (error) {
  refuse(`a document failed its schema: ${error.message}`);
}
const summary = importer.summaryOf({ history, result, docs, digest: route.digestOf(docs) });

writeFileSync(join(dirname(path), 'reconcile-report.md'), `${summary}${importer.detailsOf(history, result)}`);
process.stdout.write(summary);
process.exit(result.clean ? 0 : 1);
