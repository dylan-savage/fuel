import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The runner and every worker load this file; the env var makes them share one directory.
process.env.FUEL_E2E_DIR ??= mkdtempSync(join(tmpdir(), 'fuel-e2e-'));
const dir = process.env.FUEL_E2E_DIR;
const port = 8788;
const upstream = `http://127.0.0.1:8790`;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'iphone-webkit', use: { ...devices['iPhone 17'] } }],
  webServer: [
    {
      command: 'node e2e/upstream.mjs',
      url: `${upstream}/healthz`,
      reuseExistingServer: false,
      env: { FUEL_UPSTREAM_PORT: '8790' },
    },
    {
      command: 'node dist/server/main.js',
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      env: {
        FUEL_PORT: String(port),
        FUEL_DATA_DIR: join(dir, 'data'),
        FUEL_BACKUP_DIR: join(dir, 'backups'),
        FUEL_OFF_URL: upstream,
        FUEL_OFF_SEARCH_URL: upstream,
        FUEL_USDA_URL: upstream,
        // USDA stays off in the browser pass, even when the shell running it has a key.
        USDA_API_KEY: '',
      },
    },
  ],
});
