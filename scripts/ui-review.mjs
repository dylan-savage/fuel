#!/usr/bin/env node
// Photographs the built app the way Dylan sees it: an iPhone-sized WebKit browser, real data.
//
//   npm run build && node scripts/ui-review.mjs <label> [--dark] [--serve]
//   node scripts/ui-review.mjs --sheet <dir>
//
// It copies the live database, serves the copy on its own port and walks the training screens,
// logging a set on the copy, so nothing touches the live server. The copy and the shots hold real data, so both stay under
// .private/ui-review, which git ignores. Food screens use invented data in e2e/shots.spec.ts,
// because the live diary is empty. --serve keeps the server up for a live look at port 8796.
// --sheet makes contact sheets of a folder of shots, such as those, and does nothing else.
/* global window, document */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { devices, webkit } from '@playwright/test';

const args = process.argv.slice(2);

/** One image of every shot with its name, because reading them one at a time costs far more. Answers how many shots and sheets it made. */
async function contactSheets(browser, from, to, prefix) {
  const context = await browser.newContext({ viewport: { width: 1560, height: 900 } });
  const sheet = await context.newPage();
  const files = readdirSync(from).filter((f) => f.endsWith('.png') && !f.startsWith('contact-')).sort();
  for (let i = 0; i < files.length; i += 10) {
    const cells = files.slice(i, i + 10).map((f) => {
      const src = `data:image/png;base64,${readFileSync(join(from, f)).toString('base64')}`;
      return `<figure><figcaption>${f}</figcaption><img decoding="sync" src="${src}"></figure>`;
    });
    await sheet.setContent(`<!doctype html><style>
      body{margin:8px;background:#666;font:13px -apple-system,sans-serif;color:#fff;display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
      figure{margin:0}figcaption{padding:2px 0}img{width:100%;display:block}
    </style>${cells.join('')}`);
    await sheet.waitForLoadState('load');
    // WebKit decodes a large image late, and an undecoded one photographs as nothing, so decode every cell before the photograph.
    await sheet.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
    await sheet.screenshot({ path: join(to, `${prefix}-${i / 10 + 1}.png`), fullPage: true });
  }
  await context.close();
  return { shots: files.length, sheets: Math.ceil(files.length / 10) };
}

const sheetAt = args.indexOf('--sheet');
if (sheetAt !== -1) {
  const dir = resolve(args[sheetAt + 1] ?? '.');
  const browser = await webkit.launch();
  process.stdout.write(`${JSON.stringify({ dir, ...(await contactSheets(browser, dir, dir, 'contact')) })}\n`);
  await browser.close();
  process.exit(0);
}

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

// A set in the last three hours of the real data starts the app on Train, and this tab finds it either way.
await tab('Train');
const week = page.getByTestId('week-count');
await week.waitFor({ timeout: 20_000 });

await shot('train-week');
await shot('train-week-bottom', () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
await page.evaluate(() => window.scrollTo(0, 0));

await shot('coach', () => train.getByRole('button', { name: /^Coach/ }).click({ timeout: 4000 }));
await shot('coach-bottom', scrollSheet);
await close();
await shot('program', () => button(/^Program/).click({ timeout: 4000 }));
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

// A real day, on the copy: the list, an exercise, a set logged, each of the five actions, and back.
const back = () => page.getByRole('button', { name: 'Back', exact: true }).click({ timeout: 4000 });
const pageBottom = () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
const pageTop = () => page.evaluate(() => window.scrollTo(0, 0));
const exercises = page.locator('.train button.row:has(.dots)');
const days = page.getByRole('list', { name: 'Days' }).getByRole('button');

/** The first day with exercises to log, passing over a cardio-only one. */
async function openLiftingDay() {
  const undone = days.filter({ hasNotText: 'Done' });
  const choices = (await undone.count()) > 0 ? undone : days;
  for (let i = 0; i < (await choices.count()); i++) {
    await choices.nth(i).click({ timeout: 4000 });
    await page.waitForTimeout(300);
    if ((await exercises.count()) > 0) return;
    await back();
    await page.waitForTimeout(150);
  }
}

/** A load on an exercise with no history, so Log set can be tapped. */
async function fillBlanks() {
  const load = page.getByLabel('Load', { exact: true });
  if ((await load.count()) > 0 && (await load.inputValue()) === '') await load.fill('50');
  const band = page.getByLabel('Band', { exact: true });
  if ((await band.count()) > 0 && (await band.inputValue()) === '') await band.fill('green');
}

// Every day once, for what one day holds and another does not, and the first checklist opened.
let checklistSeen = false;
for (let i = 0; i < (await days.count()); i++) {
  await shot(`day-${i + 1}`, () => days.nth(i).click({ timeout: 4000 }));
  const checklist = page.locator('details.expand summary').filter({ hasText: /\d moves?/ }).first();
  if (!checklistSeen && (await checklist.count()) > 0) {
    checklistSeen = true;
    await shot('day-checklist', () => checklist.click({ timeout: 2000 }));
  }
  await back();
  await page.waitForTimeout(150);
}

await shot('day', openLiftingDay);
await shot('day-bottom', async () => {
  await page.getByRole('region', { name: 'Optional' }).locator('summary').first().click({ timeout: 2000 }).catch(() => {});
  await pageBottom();
});
await pageTop();

const openExercises = exercises.filter({ visible: true });
await shot('exercise', () => openExercises.first().click({ timeout: 4000 }));
await shot('exercise-logged', async () => {
  await fillBlanks();
  await button('Log set').click({ timeout: 4000 });
  await page.waitForTimeout(450);
});
await shot('exercise-after-set', () => page.getByRole('status').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {}));
await shot('action-swap', () => button('Swap').click({ timeout: 4000 }));
await close();
await shot('action-skip', () => button('Skip').click({ timeout: 4000 }));
await close();
await shot('action-note', () => button('Note').click({ timeout: 4000 }));
await close();
await shot('action-cue', () => button('Cue').click({ timeout: 4000 }));
await close();
await shot('action-warm-up', () => button('Warm-up').click({ timeout: 4000 }));
await button('Warm-up').click({ timeout: 4000 });
await shot('edit-set', () => page.getByRole('group', { name: "Today's sets" }).getByRole('button').first().click({ timeout: 2000 }));
await close();
await shot('day-after-set', back);
await shot('exercise-out-of-order', () => openExercises.last().click({ timeout: 4000 }));
await back();
await shot('week-after-set', back);

await shot('diary', () => tab('Diary'));
await shot('add', () => tab('Add'));
await shot('scan', () => page.getByRole('button', { name: 'Scan', exact: true }).click({ timeout: 4000 }));
await close();
await shot('goal', () => tab('Goal'));

await context.close();

const { shots, sheets } = await contactSheets(browser, out, join(root, label), `contact-${colorScheme}`);
await browser.close();

process.stdout.write(`${JSON.stringify({ out, shots, sheets, failures })}\n`);
if (args.includes('--serve')) {
  process.stdout.write(`serving the copy at ${base}, Ctrl-C to stop\n`);
  await new Promise(() => {});
}
stopServer();
process.exit(0);
