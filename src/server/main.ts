/** Process entry point, run by launchd through scripts/run.sh. */
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { Millis } from '../domain/ids.js';
import { createAiParser } from './ai.js';
import { scheduleBackups } from './backup.js';
import { createFoodSources } from './foods.js';
import { log } from './log.js';
import { createOffClient } from './off.js';
import { buildApp } from './routes.js';
import { openStore } from './store.js';
import { createUsdaClient } from './usda.js';

/** Env is parsed here and nowhere else. */
const Config = z.object({
  FUEL_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Outside the checkout, so `git clean` can never touch the database. */
  FUEL_DATA_DIR: z.string().min(1).default(join(homedir(), 'Library/Application Support/fuel')),
  FUEL_BACKUP_DIR: z.string().min(1).default(join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/fuel-backups')),
  FUEL_BACKUP_KEEP: z.coerce.number().int().positive().default(30),
  FUEL_STATIC_DIR: z.string().min(1).default(fileURLToPath(new URL('../client', import.meta.url))),
  /** Optional. Unset or empty means search is Open Food Facts only. Never logged. */
  USDA_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((key) => (key === undefined || key === '' ? null : key)),
  /** Optional. Unset or empty means AI quick log answers 503 ai_unconfigured. Never logged. */
  ANTHROPIC_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((key) => (key === undefined || key === '' ? null : key)),
  /**
   * The current Opus, run at low effort (src/server/ai.ts): structured extraction like this
   * keeps its quality at low effort, which is the quickest setting. Set a Haiku or Sonnet id
   * here to compare latency with scripts/ai-smoke.mjs.
   */
  FUEL_AI_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  FUEL_OFF_URL: z.url().default('https://world.openfoodfacts.org'),
  FUEL_OFF_SEARCH_URL: z.url().default('https://search.openfoodfacts.org'),
  FUEL_USDA_URL: z.url().default('https://api.nal.usda.gov/fdc'),
});

const Package = z.object({ version: z.string().min(1) });

const config = Config.parse(process.env);
const { version } = Package.parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')));
const userAgent = `fuel/${version} (single-user calorie tracker)`;
const now = () => Millis.parse(Date.now());

mkdirSync(config.FUEL_DATA_DIR, { recursive: true });
const store = openStore(join(config.FUEL_DATA_DIR, 'fuel.db'));
const off = createOffClient({ productUrl: config.FUEL_OFF_URL, searchUrl: config.FUEL_OFF_SEARCH_URL, userAgent, fetch, now });
const usda =
  config.USDA_API_KEY === null ? null : createUsdaClient({ baseUrl: config.FUEL_USDA_URL, apiKey: config.USDA_API_KEY, userAgent, fetch });
const foods = createFoodSources({ off, usda, cache: store.lookupCache, now });
const ai =
  config.ANTHROPIC_API_KEY === null
    ? null
    : createAiParser({ messages: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }).beta.messages, model: config.FUEL_AI_MODEL });
const app = buildApp({ store, foods, ai, staticDir: config.FUEL_STATIC_DIR, now });
const backups = scheduleBackups({ store, dir: config.FUEL_BACKUP_DIR, keep: config.FUEL_BACKUP_KEEP });

// Loopback only: `tailscale serve` terminates HTTPS and is the only way in from the network.
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.FUEL_PORT }, (info) => {
  log('listening', {
    port: info.port,
    dataDir: config.FUEL_DATA_DIR,
    staticDir: config.FUEL_STATIC_DIR,
    usda: usda !== null,
    ai: ai === null ? null : config.FUEL_AI_MODEL,
  });
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
