/**
 * Process entry point, run by launchd (scripts/com.dylansavage.fuel.plist via scripts/run.sh).
 * Parses config, opens the store, wires adapters, serves, and schedules backups.
 */
import { z } from 'zod';
import { todo } from '../todo.js';

/** Env is parsed once here. Nothing else reads process.env. */
export const Config = z.object({
  FUEL_PORT: z.coerce.number().int().default(8787),
  /** Outside the git checkout so `git clean` can never touch the database. */
  FUEL_DATA_DIR: z.string().default(`${process.env.HOME ?? ''}/Library/Application Support/fuel`),
  FUEL_STATIC_DIR: z.string().default('dist/client'),
  /** From tokenstash into .env. Absent means AI routes answer 503 and the rest of the app works. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  FUEL_AI_MODEL: z.string().default('claude-opus-5-5'),
  USDA_API_KEY: z.string().default('DEMO_KEY'),
  FUEL_OFF_USER_AGENT: z.string().default('fuel/0.1 (personal food diary)'),
  FUEL_BACKUP_KEEP: z.coerce.number().int().positive().default(30),
});
export type Config = z.infer<typeof Config>;

/**
 * Binds 127.0.0.1 only. `tailscale serve --bg 8787` terminates HTTPS for
 * dylans-mac-mini.tail82aa2c.ts.net and is the only path in from the network, so the
 * tailnet is the perimeter without any app-level auth.
 * Backups: at startup and hourly, if fuel-<today>.db is missing, store.backup(...).
 */
export async function main(env: Record<string, string | undefined>): Promise<void> {
  return todo(`main(${Object.keys(env).length} env vars)`);
}
