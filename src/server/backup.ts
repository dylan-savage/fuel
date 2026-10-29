/** Daily online backups of fuel.db into a folder iCloud Drive syncs off the mini. */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import type { DocStore } from './store.js';

const BACKUP_NAME = /^fuel-\d{4}-\d{2}-\d{2}\.db$/;
const HOUR_MS = 60 * 60 * 1000;

export interface BackupPolicy {
  readonly store: Pick<DocStore, 'backup'>;
  readonly dir: string;
  /** How many daily files to keep. */
  readonly keep: number;
}

/** YYYY-MM-DD in the mini's local time zone. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Writes fuel-<day>.db unless it already exists, then deletes all but the newest `keep`.
 * A crash mid-copy leaves only a temp file, which the next run replaces.
 */
export async function backupIfDue({ store, dir, keep }: BackupPolicy, day: string): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const name = `fuel-${day}.db`;
  const target = join(dir, name);
  if (existsSync(target)) return null;

  const temp = join(dir, `.${name}.tmp`);
  rmSync(temp, { force: true });
  await store.backup(temp);
  renameSync(temp, target);

  const backups = readdirSync(dir)
    .filter((file) => BACKUP_NAME.test(file))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dir, old));
  return target;
}

/** Checks hourly, so the day's backup happens soon after midnight or soon after boot. */
export function scheduleBackups(policy: BackupPolicy, now: () => Date = () => new Date()): { stop(): void } {
  const run = () => {
    backupIfDue(policy, localDay(now()))
      .then((file) => {
        if (file !== null) log('backup_written', { file });
      })
      .catch((err: unknown) => {
        log('backup_failed', { error: String(err) });
      });
  };
  run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
