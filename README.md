# fuel

fuel is Dylan's calorie and macro tracker, replacing MyFitnessPal. It runs as a Home Screen web app on the iPhone and keeps a full copy of the diary in IndexedDB, so logging is instant and works with no signal. Writes queue in an outbox and sync to SQLite on the Mac mini, reached over Tailscale, whenever the app is open and the mini is reachable.

The approved design is [docs/design/design.md](docs/design/design.md), with open questions in [docs/design/open-questions.md](docs/design/open-questions.md). To install it on the mini, follow [docs/mini-setup.md](docs/mini-setup.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server on `:8787` against a throwaway database, and Vite on `:5173` proxying `/api` to it. The service worker is off in dev. |
| `npm test` | Runs vitest: domain math, GTIN parsing through the real decoder, `DocStore`, routes, intents, the sync loop, the sync simulation, and the schema history pin. |
| `npm run typecheck` | Checks the domain (no DOM, no Node types), server, client and tests with their own tsconfigs. |
| `npm run lint` | Runs eslint, including the import boundaries between domain, server, client and screens. |
| `npm run build` | Builds the PWA into `dist/client` and the server into `dist/server`. |
| `npm run e2e` | Builds, then runs Playwright WebKit on an iPhone profile against the real server: offline reload, quick add offline, sync on reconnect, and a barcode photo decoded offline. |
| `npm run icons` | Regenerates the PNG icons in `public/icons`. |

The simulation runs 150 random schedules per property. Set `FUEL_SIM_RUNS` to run more, and `FUEL_SIM_SEED` to replay a failing seed.

## Layout

| Path | Contents |
|---|---|
| `src/domain/` | Pure types and math. `kinds.ts` is the only list of document kinds, and `SCHEMA_HISTORY` derives the IndexedDB version. |
| `src/protocol.ts` | zod schemas for `POST /api/sync`. |
| `src/server/` | `store.ts` (the only SQL), `routes.ts`, `backup.ts`, `main.ts`. |
| `src/client/` | `replica.ts` (the only Dexie import), `sync.ts`, `intents.ts`, `views.ts`, `scanner.ts`, and the Preact screens. |
| `test/`, `e2e/` | Unit, integration, simulation and browser tests. |
| `scripts/` | `run.sh` and the launchd plist for the mini, plus the dev and icon scripts. |

When you add a document kind, add one line to `KINDS` in `src/domain/kinds.ts`. If the IndexedDB layout changes, the schema history test fails. Append the new `dexieStores()` output to `SCHEMA_HISTORY` to fix it.
