# fuel

fuel is Dylan's calorie and macro tracker, replacing MyFitnessPal. It runs as a Home Screen web app on the iPhone and keeps a full copy of the diary in IndexedDB, so logging is instant and works with no signal. Writes queue in an outbox and sync to SQLite on the Mac mini, reached over Tailscale, whenever the app is open and the mini is reachable.

The approved design is [docs/design/design.md](docs/design/design.md), with open questions in [docs/design/open-questions.md](docs/design/open-questions.md). To install it on the mini, follow [docs/mini-setup.md](docs/mini-setup.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server on `:8787` against a throwaway database, and Vite on `:5173` proxying `/api` to it. The service worker is off in dev. |
| `npm test` | Runs vitest: domain math (budget and both workout policies, the weight trend, weekly rate and goal projection, net MET burn, totals, recents, search, recipes, the food-edit refresh, water, the fast state machine and streaks), GTIN parsing through the real decoder, the Open Food Facts adapter against recorded responses, the lookup policy and cache, `DocStore`, routes, intents (including two phones syncing water, overlapping fasts and same-day weigh-ins), the sync loop, the sync simulation over every kind, and the schema history pin. |
| `npm run typecheck` | Checks the domain (no DOM, no Node types), server, client and tests with their own tsconfigs. |
| `npm run lint` | Runs eslint, including the import boundaries between domain, server, client and screens. |
| `npm run build` | Builds the PWA into `dist/client` and the server into `dist/server`. |
| `npm run e2e` | Builds, then runs Playwright WebKit on an iPhone profile against the real server, with Open Food Facts answered from the recorded fixtures by `e2e/upstream.mjs`. It sets a goal, looks up a barcode, confirms and logs it, logs a recent and a known barcode offline, checks the writes reach `fuel.db`, and decodes a barcode photo offline. It builds a recipe and logs a serving, saves a meal and logs it in one tap, copies yesterday's breakfast, answers the food-edit prompt, adds water offline, and starts a fast offline and ends it online. It logs weigh-ins over two weeks and sees the trend, rate and projected goal date, logs a workout offline, and switches to eating back workouts. Set `FUEL_SHOTS_DIR` to choose where the light and dark screenshots go (default `test-results/shots`). |
| `node --env-file-if-exists=../.env.local scripts/record-fixtures.mjs [off] [usda]` | Re-records the Open Food Facts and USDA responses in `test/fixtures`. It needs the network, and USDA needs `USDA_API_KEY`. It refuses to write a file that contains the key. |
| `npm run icons` | Regenerates the PNG icons in `public/icons`. |

The simulation runs 150 random schedules per property. Set `FUEL_SIM_RUNS` to run more, and `FUEL_SIM_SEED` to replay a failing seed.

## Layout

| Path | Contents |
|---|---|
| `src/domain/` | Pure types and math. `kinds.ts` is the only list of document kinds, and `SCHEMA_HISTORY` derives the IndexedDB version. `reuse.ts` holds recipes, saved meals and the food-edit refresh; `habits.ts` holds water and fasts; `body.ts` holds weigh-ins and the trend; `burn.ts` holds workouts and the MET table. |
| `src/protocol.ts` | zod schemas for every HTTP body: sync, food lookup and food search. |
| `src/server/` | `store.ts` (the only SQL, including the lookup cache), `routes.ts`, `foods.ts` (which source answers, caching and merging), `off.ts` and `usda.ts` (the only code that reads their JSON), `upstream.ts`, `backup.ts`, `main.ts`. |
| `src/client/` | `replica.ts` (the only Dexie import), `sync.ts`, `intents.ts`, `views.ts`, `api.ts`, `scanner.ts`, and the Preact screens. `screens/flow.tsx` is the one state machine for the sheets that end in a diary entry. |
| `test/`, `e2e/` | Unit, integration, simulation and browser tests. `test/fixtures/` holds the recorded external responses. |
| `scripts/` | `run.sh` and the launchd plist for the mini, plus the dev and icon scripts. |

When you add a document kind, add one line to `KINDS` in `src/domain/kinds.ts`. If the IndexedDB layout changes, the schema history test fails. Append the new `dexieStores()` output to `SCHEMA_HISTORY` to fix it.
