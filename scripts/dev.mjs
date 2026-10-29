// The server, rebuilt on change, on :8787 against a throwaway database, and Vite on :5173
// proxying /api to it. The service worker is off in dev.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const dataDir = mkdtempSync(join(tmpdir(), 'fuel-dev-'));
const env = {
  ...process.env,
  FUEL_PORT: '8787',
  FUEL_DATA_DIR: dataDir,
  FUEL_BACKUP_DIR: join(dataDir, 'backups'),
  FUEL_STATIC_DIR: join(root, 'src', 'client'),
};

execFileSync(bin('tsc'), ['-p', 'tsconfig.server.json'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`dev database: ${dataDir}\n`);

const children = [
  spawn(bin('tsc'), ['-p', 'tsconfig.server.json', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', join('dist', 'server', 'main.js')], { cwd: root, stdio: 'inherit', env }),
  spawn(bin('vite'), ['--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' }),
];
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
