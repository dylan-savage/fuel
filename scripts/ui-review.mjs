#!/usr/bin/env node
// Photographs the built app the way Dylan sees it: an iPhone-sized WebKit browser, real data.
//
//   npm run build && node scripts/ui-review.mjs <label> [--dark] [--serve]
//
// It copies the live database, serves the copy on its own port and walks the training screens,
// so nothing touches the live server. The copy and the shots hold real data, so both stay under
// .private/ui-review, which git ignores. Food screens use invented data in e2e/shots.spec.ts,
// because the live diary is empty. --serve keeps the server up for a live look at port 8796.
/* global window, document */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { devices, webkit } from '@playwright/test';

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) ?? 'latest';
const colorScheme = args.includes('--dark') ? 'dark' : 'light';
const PORT = 8796;
const base = `http://127.0.0.1:${PORT}`;
const root = resolve('.private/ui-review');
const data = join(root, 'data');
const out = join(root, label, colorScheme);

rmSync(data, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
mkdirSync(out, { recursive: true });
execFileSync('sqlite3', [join(homedir(), 'Library/Application Support/fuel/fuel.db'), `.backup '${join(data, 'fuel.db')}'`]);

const server = spawn('node', ['dist/server/main.js'], {
  env: {
    PATH: process.env.PATH,
    HOME: homedir(),
    FUEL_PORT: String(PORT),
    FUEL_DATA_DIR: data,
    FUEL_BACKUP_DIR: join(data, 'backups'),
    FUEL_OFF_URL: 'http://127.0.0.1:9',
    FUEL_OFF_SEARCH_URL: 'http://127.0.0.1:9',
    FUEL_USDA_URL: 'http://127.0.0.1:9',
    USDA_API_KEY: '',
  },
  stdio: 'ignore',
});
const stopServer = () => server.kill();
process.on('exit', stopServer);

for (let i = 0; i < 50; i++) {
  const up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices['iPhone 17'], colorScheme, serviceWorkers: 'block' });
const page = await context.newPage();
await page.goto(base);

let n = 0;
const failures = [];
async function shot(name, act) {
  const file = `${String(++n).padStart(2, '0')}-${name}.png`;
  try {
    if (act) await act();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, file), animations: 'disabled' });
  } catch (err) {
    failures.push(`${name}: ${String(err.message).split('\n')[0]}`);
  }
}

const tab = (name) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true }).click({ timeout: 4000 });
const dialog = () => page.getByRole('dialog').last();
const scrollSheet = () => dialog().locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
const close = async () => {
  const sheets = page.getByRole('dialog');
  for (let i = await sheets.count(); i > 0; i--) {
    await sheets.last().getByRole('button', { name: /^(Done|Cancel)$/ }).first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);
  }
};
const button = (name) => page.getByRole('button', { name }).first();

const train = page.locator('.train');

await tab('Train');
await page.getByTestId('week-count').waitFor({ timeout: 20_000 });

await shot('train-week');
await shot('train-week-bottom', () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
await page.evaluate(() => window.scrollTo(0, 0));

await shot('coach', () => train.getByRole('button', { name: /^Coach/ }).click({ timeout: 4000 }));
await shot('coach-bottom', scrollSheet);
await close();
await shot('program', () => button(/^Program/).click({ timeout: 4000 }));
await close();

const nextDay = page.getByRole('region', { name: 'Next day' });
await shot('train-day', () => nextDay.getByRole('button').first().click({ timeout: 4000 }));
await shot('train-day-exercise', () => dialog().locator('details.expand').filter({ hasNotText: /moves|Optional/ }).nth(1).locator('summary').click({ timeout: 4000 }));
await shot('train-day-bottom', async () => {
  await dialog().getByRole('region', { name: 'Optional' }).locator('summary').first().click({ timeout: 2000 }).catch(() => {});
  await scrollSheet();
});
await close();

await shot('progress', () => button('Progress').click({ timeout: 4000 }));
await shot('progress-bottom', scrollSheet);
await dialog().locator('.sheet-body').evaluate((el) => el.scrollTo(0, 0));
await shot('lift', () => page.getByTestId('board').getByRole('button').filter({ hasText: /[+−]\d/ }).first().click({ timeout: 4000 }));
await shot('lift-bottom', scrollSheet);
await close();
await page.waitForTimeout(150);
await shot('all-lifts', async () => {
  await button('Progress').click({ timeout: 4000 });
  await dialog().getByRole('button', { name: /All lifts/ }).click({ timeout: 4000 });
});
await close();

// A real session, on the copy: the first lifts it reaches, a rest once a round ends, and each sheet over it.
await nextDay.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 4000 });
await page.waitForTimeout(400);
for (let i = 0; i < 6; i++) {
  if (await page.getByRole('region', { name: 'Set', exact: true }).count()) break;
  await page.getByRole('button', { name: 'Done', exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400);
}
await shot('session-card');
await shot('session-logged', async () => {
  await button('Log set').click({ timeout: 4000 });
  await page.waitForTimeout(450);
});
for (let i = 0; i < 6 && (await page.getByRole('timer').count()) === 0; i++) {
  await button('Log set').click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(450);
}
await shot('session-rest', () => page.getByRole('status').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {}));
await shot('session-plan', () => button('Plan').click({ timeout: 4000 }));
await shot('session-plan-bottom', scrollSheet);
await close();
await shot('session-swap', () => button('Swap').click({ timeout: 4000 }));
await close();
await shot('session-note', () => button('Note').click({ timeout: 4000 }));
await close();
await shot('session-cue', () => button('Cue').click({ timeout: 4000 }));
await close();
await shot('session-edit-set', () => page.getByRole('group', { name: "Today's sets" }).getByRole('button').first().click({ timeout: 2000 }));
await close();

await shot('diary', () => tab('Diary'));
await shot('add', () => tab('Add'));
await shot('scan', () => page.getByRole('button', { name: 'Scan', exact: true }).click({ timeout: 4000 }));
await close();
await shot('goal', () => tab('Goal'));

await context.close();

// One image of every shot with its name, because reading them one at a time costs far more.
const sheetContext = await browser.newContext({ viewport: { width: 1560, height: 900 } });
const sheet = await sheetContext.newPage();
const files = readdirSync(out).filter((f) => f.endsWith('.png')).sort();
for (let i = 0; i < files.length; i += 10) {
  const cells = files.slice(i, i + 10).map((f) => {
    const src = `data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}`;
    return `<figure><figcaption>${f}</figcaption><img src="${src}"></figure>`;
  });
  await sheet.setContent(`<!doctype html><style>
    body{margin:8px;background:#666;font:13px -apple-system,sans-serif;color:#fff;display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
    figure{margin:0}figcaption{padding:2px 0}img{width:100%;display:block}
  </style>${cells.join('')}`);
  await sheet.waitForLoadState('load');
  await sheet.screenshot({ path: join(root, label, `contact-${colorScheme}-${i / 10 + 1}.png`), fullPage: true });
}
await browser.close();

process.stdout.write(`${JSON.stringify({ out, shots: files.length, sheets: Math.ceil(files.length / 10), failures })}\n`);
if (args.includes('--serve')) {
  process.stdout.write(`serving the copy at ${base}, Ctrl-C to stop\n`);
  await new Promise(() => {});
}
stopServer();
process.exit(0);
