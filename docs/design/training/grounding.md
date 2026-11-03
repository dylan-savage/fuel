# How fuel works, for the training design

Written 2026-11-03 at commit 5584b8d. "Probed" means run in a throwaway copy. Lint passes at HEAD. Playwright was not run for this.

## Overview

fuel stores all user state as whole JSON documents of registered kinds. The phone holds a full copy in IndexedDB and queues writes in an outbox. The mini keeps every kind in one SQLite `doc` table and orders writes with a global revision. The server never edits documents, and totals, trends and budgets are derived on read.

## Storage and sync

**Registry.** `DEFS` in `src/domain/kinds.ts` gives each kind a schema, `dated` and `indexes`. From it come `parseDoc` (server and phone validation), `KindName` (wire validation), `dexieStores()` (Dexie tables) and `Mutation`/`DocOf` (write types). The server needs no migration.

**`SCHEMA_HISTORY`** is an append-only list of full layouts whose length is `DB_VERSION`. Dexie diffs the current layout against the installed database, and no data-migration path exists. A new kind or index means appending the new `dexieStores()` output.

**One write.** `intents.logWorkout` builds the document and calls `replica.commit`, which parses every put (`InvalidDocument`, nothing written), then writes the row and an outbox row in one transaction. `onCommit` pokes `startSync`, and `syncRounds` sends `nextBatch(500)` to `POST /api/sync`. `store.sync`, in `BEGIN IMMEDIATE`, skips ids at or below `last_mutation_id` and runs `check()`. A valid mutation gets `MAX(rev) + 1` and an upsert, and deletes keep a `body NULL` row forever. An invalid one goes to `rejection` and still counts as processed. The response carries up to 1000 rows above the cursor, all kinds, own writes included. `port.apply` deletes acknowledged outbox rows, then skips pulled changes for documents still pending: a pending whole document reaches the server after everything pulled, so it wins there too.

**`last_mutation_id`** makes a lost response safe to retry. **Epoch** marks a restored database: on mismatch the server pulls from 0 and the phone re-queues every document it holds, so deletes made after the backup come back.

**A script as a client.** Nothing is phone-specific, and `seed()` in `e2e/app.ts` already does this. Send `clientId` (UUID), `epoch`, `cursor` and up to 500 `mutations` with ascending positive ids: `{op:'put', id, kind, docId, doc}` or `{op:'delete', id, kind, docId}`. `doc` must pass the deployed schema and `doc.id` must equal `docId`. A durable client persists its id and counter (an empty push returns `lastMutationId`), checks `rejected` and loops on `more`. `epoch` and `rev` from `/healthz` pull nothing, and a null epoch pulls from rev 0 (probed). The gaps: no writer field on kinds, no base-revision check, `written_by` never read, and the phone sees the write only on its next sync.

**Auth.** None. `/api/sync` has only a 5 MiB `bodyLimit`. The `127.0.0.1` bind plus `tailscale serve` is the perimeter, so any local process or tailnet device can read and overwrite everything.

## Client structure

`replica.ts` is the only Dexie import, and only `sync.ts` holds its `SyncPort`. `FuelContext` (`main.tsx`) gives screens a narrowed replica, intents and sync state. `views.ts` holds read models over domain functions. `intents.ts` reads, builds whole documents, makes exactly one commit and usually returns an `Undo`. Screens read with `useLive(query, deps)` (`undefined` until IndexedDB answers), gate forms with domain schemas, close the sheet, then run the intent and toast its undo.

No router exists. `App` holds `tab` in `useState` and renders conditionally, so switching tabs unmounts the screen and loses uncommitted form state, and a reload lands on Diary. Sheets are local state in their owner, using `Sheet` and `Alert` from `ui.tsx`. A new tab touches `Tab`, `TABS` and the `<main>` branch in `app.tsx`, `ICONS` in `ui.tsx`, `repeat(4, 1fr)` at `styles.css:1272` (no error if missed) and the `tab()` union in `e2e/app.ts`.

The service worker (`generateSW`, `registerType: 'prompt'`) precaches the shell and lazy chunks, and data never passes through it. After a deploy the old shell runs until Dylan taps the banner in `App`.

## Neighbors

**WeighIn** (`body.ts`, `Weight.tsx`): one per day in kg, opened from `WeightTile`. `dayView` passes it through `budgetOn` and `bodyWeightOn` to `trendSeries`, which feeds BMR.

**Workout** (`burn.ts`, `Workouts.tsx`): fixes `kg` and net `kcal` at log time and renders under the meals. `budgetFor` adds `workoutShare × workoutKcal`, which is 0 under the default `activity-level` policy.

**Deterministic ids:** `w:<date>`, `g:<effectiveFrom>` (both enforced by `.refine`) and profile `me`, so two offline phones converge on one document. Everything else uses UUIDs, so both writes count. `(kind, id)` is the only uniqueness constraint. `fast`/`fastEnd` is the precedent for splitting a document so writers cannot clobber each other.

**Snapshots:** entries, recipe ingredients and saved-meal items hold `FoodSnapshot` by value plus a soft `origin`. Recipes and saved meals re-snapshot only on the prompt's yes (`refreshFor`), and entries never do. This is a direct precedent for a session capturing its prescription.

**Units:** kg and ml stored, lb and fl oz shown through `format.ts`, with screens converting at the form (`KG_PER_LB`).

## Reads at scale

`ReplicaReader` offers `get`, `onDate`, `between`, `all`, `withBarcode` and `pendingCount`, with no limit, order or reverse. Reads do not parse. "Latest for key X across all time" today means `all(kind)` then filtering and sorting in JS: every row cloned out of IndexedDB per run, re-run by any write to that table under `useLive`. `workoutLoggerView` and `bodyView` do this now. `recentsView` bounds it with 90 days of `between`, missing anything older. The real cost is unmeasured. On the mini, pulls cannot filter by kind and `doc.body` JSON has no expression indexes.

## Tests and gates

Vitest covers domain units, adapters, `store` and routes. `replica.test.ts` and `intents.test.ts` use fake-indexeddb. `sync.sim.test.ts` (fast-check, 150 runs) drives real replicas and a real `DocStore` through dropped and doubled delivery and restores. Playwright runs WebKit on an iPhone profile against the built server.

`kinds.test.ts` pins `dexieStores()` to the last history entry and `DB_VERSION` to the length, plus sample `parseDoc` rules. Unknown-field survival is tested for `entry` only.

Lint bans type assertions everywhere, tests included (`as const` remains, and brands go through `.parse`), and requires exhaustive switches and type imports. Domain and `protocol.ts` import no server, client, `node:` or IO libraries, and screens cannot import `replica`. tsconfig adds `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. No CI or git hooks exist, so gates are manual.

## Deploy and backup

`scripts/deploy.sh` clones the Desktop checkout to `~/fuel`, pulls its local `main` (not GitHub, not a branch), builds and restarts launchd, whose processes cannot read `~/Desktop`. `main.ts` opens `fuel.db` in `FUEL_DATA_DIR`, default `~/Library/Application Support/fuel`. `run.sh` pins the Node binary for the `better-sqlite3` ABI.

`scheduleBackups` writes `fuel-<day>.db` daily to iCloud Drive, keeping 30. Backups cover the whole database, not `.env.local`, the phone outbox or anything outside `fuel.db`.

A mini script has three routes: HTTP to `127.0.0.1:8787`, in-process `openStore` from `~/fuel/dist/server/store.js`, or direct SQLite. A deploy's `npm ci` and `rm -rf dist` remove the second route's files while they run. Rev is read inside the immediate transaction, so a second process looks safe but is untested. `stored()` in `e2e/app.ts` reads SQLite read-only. Direct writes bypass validation and must stamp a unique rev.

## Gotchas

- **Adding a kind causes no compile errors** (probed). One new line passed all four `tsc` projects and failed one of 262 tests, the pin. The simulation's `SLOT_WRITES` is hand-written and unchecked against `KIND_NAMES`, so a new kind has no sync coverage until it is added there.
- **A new kind stops sync on every unrefreshed shell.** `KindName` fails the whole `SyncResponse.parse` (probed). Pushes still land but the outbox never clears, and with an empty outbox `Waiting` renders nothing. A coach writing a new kind before the banner tap triggers this. A known-kind document the old schema rejects aborts `apply` the same way, so new required fields are unsafe.
- **`z.object` loses data.** The server stores parser output, so unknown fields vanish. `z.looseObject` is convention, not enforced. Intents rebuilding from a form need `keepUnknown`.
- **`.pick` and `.omit` throw on refined objects** (probed), hence `GoalFields` before `Goal`.
- **`datedDoc` hard-codes `indexes: []`**, and any index needs a new `ReplicaReader` method, like `withBarcode`.
- **Script failures are quiet** (probed). A reused mutation id answers success and writes nothing. An invalid document is a rejection inside a 200.
- **Last arrival wins per document.** A phone's pending offline write beats a newer coach write. After a restore the phone re-pushes coach documents as its own.
- **Outbox rows are not coalesced.** Each edit queues the full document. `syncRounds` never shrinks a batch, so 500 rows over 5 MiB answers 413 on every retry.
- **Importing older weigh-ins moves past targets**, because the trend is derived from the first weigh-in.
- **WAL.** `fuel.db` may hold newer data in `-wal`. Never copy it raw.
- **Stale references.** `design.md` names `scripts/restore.sh` and `h:<date>`, which do not exist. Restore is a `sqlite3` runbook, and `rotateEpoch()` runs only in tests.
- **The repo is public.** Real training data lives only in `.private/`, which git ignores.
