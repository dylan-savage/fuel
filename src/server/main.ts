/** Process entry point, run by launchd through scripts/run.sh. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { Millis } from '../domain/ids.js';
import { scheduleBackups } from './backup.js';
import { log } from './log.js';
import { buildApp } from './routes.js';
import { openStore } from './store.js';

/** Env is parsed here and nowhere else. */
const Config = z.object({
  FUEL_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Outside the checkout, so `git clean` can never touch the database. */
  FUEL_DATA_DIR: z.string().min(1).default(join(homedir(), 'Library/Application Support/fuel')),
  FUEL_BACKUP_DIR: z.string().min(1).default(join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/fuel-backups')),
  FUEL_BACKUP_KEEP: z.coerce.number().int().positive().default(30),
  FUEL_STATIC_DIR: z.string().min(1).default(fileURLToPath(new URL('../client', import.meta.url))),
});

const config = Config.parse(process.env);
mkdirSync(config.FUEL_DATA_DIR, { recursive: true });
const store = openStore(join(config.FUEL_DATA_DIR, 'fuel.db'));
const app = buildApp({ store, staticDir: config.FUEL_STATIC_DIR, now: () => Millis.parse(Date.now()) });
const backups = scheduleBackups({ store, dir: config.FUEL_BACKUP_DIR, keep: config.FUEL_BACKUP_KEEP });

// Loopback only: `tailscale serve` terminates HTTPS and is the only way in from the network.
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.FUEL_PORT }, (info) => {
  log('listening', { port: info.port, dataDir: config.FUEL_DATA_DIR, staticDir: config.FUEL_STATIC_DIR });
});

const shutdown = (signal: string) => {
  log('stopping', { signal });
  backups.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
