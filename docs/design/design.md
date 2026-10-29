# fuel design

Status: approved 2026-10-28 (phone-first). Wearable burn import deferred the same day. Open questions are in [open-questions.md](open-questions.md).

## Problem

fuel replaces MyFitnessPal for one person. It runs as a Home Screen web app (PWA) on Dylan's iPhone. The store of record is SQLite on the Mac mini, reached over Tailscale at `https://dylans-mac-mini.tail82aa2c.ts.net`. Dylan logs food many times a day, often at restaurants and the gym, where signal is poor. The mini reboots for macOS updates. So the shape has to answer one question first: what does the app do when the mini is unreachable?

Two designs competed. Both are archived in [candidates/](candidates/). The [server-authoritative](candidates/server-authoritative/design.md) one keeps every number on the mini and renders HTML. The [local-first](candidates/local-first/design.md) one keeps a full copy of the data on the phone and syncs it. This document is the synthesis.

## Usage

What Dylan sees:

| Action | Mini reachable | Mini unreachable |
|---|---|---|
| Open the app, browse any day, see totals and remaining | instant, from the phone's copy | same |
| Log a recent or library food, recipe, saved meal, quick add, copy a meal or day | instant, synced about a second later | instant, queued, "N waiting" badge |
| Scan a product already in the library | instant | instant |
| Scan an unknown product | Open Food Facts lookup, confirm, logged | quick add, create by hand, or keep the barcode for later |
| Search | library results instantly, USDA and Open Food Facts below | library results, "online results unavailable" row |
| AI quick log (text, label photo, plate photo) | drafts to confirm | disabled with the reason |
| Weigh-in, water, fasting timer, workout | instant | instant, queued |

A screen, as the code reads:

```tsx
function DiaryScreen({ date }: { date: LocalDate }) {
  const day = useLive((r) => dayView(r, date), [date]);
  const recent = useLive((r) => recentFoods(r, now(), 12), []);
  const { intents } = useFuel();
  if (!day) return null;
  return recent?.map((f) => (
    <RecentRow food={f} onTap={() => intents.logItems([{ food: f.food, quantity: f.lastQuantity }], { date, meal: mealAt(hourNow()) })} />
  ));
}
```

## Shape

### Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript strict on the phone and the mini | The phone validates documents and computes totals offline. One language means one schema and one copy of the nutrient math. A Python server would duplicate both. |
| Server | Hono on Node 22, `better-sqlite3` | Six routes and static files. The synchronous driver makes each sync batch one uninterleaved transaction. |
| Phone store | Dexie on IndexedDB | `liveQuery` re-renders screens on local writes and sync merges alike. |
| UI | Preact, Vite, `vite-plugin-pwa` | React-shaped code with a small runtime, so the Home Screen app starts fast. |
| Barcode | `barcode-detector` (zxing-wasm), wasm served by the mini and cached | iOS Safari has no native `BarcodeDetector` (checked 2026-10-28), so decoding runs in wasm on the phone. If the live camera fails in standalone mode, a photo taken through the file input is decoded by the same library. |
| Validation | zod on both sides | The same schemas parse wire data, stored rows and the AI's structured output. |
| Tests | vitest, fake-indexeddb, fast-check, Playwright WebKit | Domain math, adapter fixtures, a fault-injecting sync simulation, one browser pass with the network cut. |
| Hosting | launchd agent `com.dylansavage.fuel`, `tailscale serve` for HTTPS | Same pattern as stash. The tailnet is the perimeter. The server binds `127.0.0.1`. |

### Documents and the kind registry

Every piece of user state is a document of one kind. `src/domain/kinds.ts` is the only list of kinds. Each entry names the zod schema and whether documents are dated. Every kind is phone-written today, so there is no writer field yet. It returns with the first server-written kind (wearable burn). The server's validation, the phone's IndexedDB tables, and the client's write type all derive from it. Per model-the-domain, adding storage for a feature is one line plus the compile errors it causes.

The phone's IndexedDB version is derived, not hand-bumped. `SCHEMA_HISTORY` is an append-only array of derived table specs, and the version is its length. A test fails when the current derived spec differs from the last entry. (Graft from the judge's review.)

### Food model

- **One basis per food.** A food has `unit` (`g`, `ml` or `portion`) and nutrients per 100 g, per 100 ml or per portion. The `per` amount is derived from the unit, never stored, so the two cannot disagree. `nutrientsFor(food, quantity)` is the only food-times-quantity math. Grams and millilitres never convert.
- **Servings** are named amounts in the food's unit ("1 large egg" is 50 g). A `Quantity` is `{ amount }` or `{ serving, count }` with the serving copied in, so it never needs a lookup.
- **Required nutrients.** A library food must have kcal, protein, carbs and fat. Fiber, sugar and sodium are optional, and unknown is never zero. External data (Open Food Facts, USDA, AI) arrives as a `FoodCandidate` with partial nutrients. `completeFood()` either returns a `Food` or names the missing fields, and the confirm sheet asks for them. An incomplete import cannot reach the diary. (Graft from server-authoritative.)
- **Quick add** entries need only kcal. Totals list them as incomplete for macros ("protein: at least 92 g").
- **History is stable.** Entries, recipe ingredients and saved-meal items hold a `FoodSnapshot` by value. Editing a food never changes a past day. A recipe can never contain itself, because it holds values, not references. After a food edit the app offers "also update 2 recipes and 1 saved meal?".
- **Recipe nutrients.** An optional nutrient in a recipe is known only when every ingredient reports it. (Fix from the judge's review. The local-first sketch summed missing values as zero.)
- **Barcodes** normalize to 13 digits with a verified check digit.
- **Units.** Body weight is stored in kg and shown in lb. Open Food Facts and USDA unit quirks are normalized in their adapters only.

### Who writes what

Per separate-before-serializing-shared-state, each piece of state has one owner.

| State | Only writer |
|---|---|
| foods, recipes, saved meals, entries, workouts, water, fasts, weigh-ins, goals, profile | the phone, through `/api/sync` pushes |
| revision counter, epoch, per-client last mutation id | the server's `DocStore` |
| totals, remaining, trend, recents, fasting state | nobody. Pure functions derive them on read. |

Ids are random UUIDs minted on the phone. Day singletons use fixed ids (`w:<date>`, `g:<date>`, `h:<date>`), so logging a weight twice converges to one document. Water is one row per drink, so two offline adds both count.

### Sync

The phone queues whole-document puts and deletes in an outbox. Each sync pushes them and pulls everything above its cursor in one request. The server applies pushes in arrival order inside one transaction and stamps each with a global revision. It skips mutation ids it has already applied, so a lost response is safe to retry. When pulled data arrives, the phone keeps its own unsynced version of a document. That is correct because every mutation is a whole document, and the unsynced write will reach the server after everything already pulled.

The only real conflict is two devices editing the same document while one is offline. The later arrival wins. 
iOS gives web apps no background sync. Sync runs on app start, after each write (debounced), on returning to the foreground, on the `online` event, and every 60 seconds while the app is open.

Screens never touch the replica's `commit` or the outbox. `FuelProvider` exposes read views and `Intents` only, and an eslint import rule makes `screens/` importing `replica.ts` a build error. (Fix for the judge's "importable internals" flag.)

### Calorie budget and workouts

All pure, in `domain/goals.ts` and `domain/burn.ts`.

```
bmr       = Mifflin-St Jeor(profile, trend weight on that day)
goal      = the goal in effect on that day (goals are effective-dated)
policy    = { kind: 'activity-level', multiplier } | { kind: 'eat-back-workouts', fraction }

activity-level:     target = bmr × multiplier + rate adjustment
                    workouts are recorded but do not change the budget
eat-back-workouts:  target = bmr × 1.2 + rate adjustment + fraction × Σ workout net kcal
remaining = target − eaten kcal
```

The default is `activity-level`, which gives a steady daily target. Workout kcal are net MET kcal, `(MET − 1) × kg × hours`, which leaves out the resting burn already in BMR. The 1.2 sedentary baseline covers digestion and light daily movement, so a logged workout is extra on top of it and never counted twice. Dylan wears an Apple Watch but does not trust its calorie numbers, so no device burn enters the budget.

### Deferred: wearable burn import

Importing measured burn is out of scope until Dylan has a wearable he trusts (decided 2026-10-28). When it lands, it adds a third policy, `{ kind: 'measured', fraction }` with `target = bmr × 1.1 + fraction × device active energy`, a server-written `health` kind (one line in `KINDS`), and an ingest route. The candidates' Shortcut contract (latest `as_of` wins per metric and day, numbers coerced from text, raw payloads logged) is the starting point. See [candidates/local-first/design.md](candidates/local-first/design.md). Nothing in the current shape blocks it.

### Module map

```
src/domain/     pure; compiled with no DOM and no Node types
  ids.ts units.ts nutrients.ts food.ts diary.ts goals.ts body.ts burn.ts habits.ts kinds.ts
src/protocol.ts zod schemas for every HTTP body
src/server/     main.ts routes.ts store.ts foods.ts off.ts usda.ts ai.ts backup.ts
src/client/     main.tsx replica.ts sync.ts intents.ts views.ts api.ts scanner.ts screens/
test/           domain units, adapter fixtures, routes, sync simulation, schema history pin
scripts/        run.sh, com.dylansavage.fuel.plist, restore.sh
```

Logging a recent food traces `screens/Diary.tsx` to `intents.ts` to `replica.ts`, with the math in `domain/diary.ts`. The server side is `routes.ts` to `store.ts`.

### HTTP surface

| Route | Purpose |
|---|---|
| `POST /api/sync` | the only write path for user data: push mutations, pull changes |
| `GET /api/foods/search?q=` | USDA and Open Food Facts text search |
| `GET /api/foods/lookup/:ref` | barcode (`gtin:`) or USDA (`usda:`) lookup, cached on the mini |
| `POST /api/ai/parse` | text or photo to draft entries or a food candidate; writes nothing |
| `GET /healthz`, `GET /*` | smoke check; the built PWA |

### Backups

Nightly online backup of `fuel.db` to an iCloud Drive folder, keeping 30 days. (Graft from server-authoritative.) The phone's full copy is a second line of defense. Restoring a backup changes the server's epoch. Phones then re-queue every document they hold, so edits made after the backup survive. A delete made after the backup comes back and has to be redone.

## Synthesis decision

**Base: local-first.** The cross-judge recommended server-authoritative, 24 to 22. It scored that design higher on operability (Python, no build step, like stash) and on invariants enforced by SQL constraints. I overrode it on one criterion, daily use, where the judge scored local-first 5 and server-authoritative 3. Per experience-first, the core loop decides. Logging happens 5 to 15 times a day. In the server design, every tap and every serving change is a round trip to the mini. Offline, totals freeze and search and scanning are refused. Barcodes go through take photo, use photo, upload. The mini also reboots for updates. The judge's maintainability concerns are real, so each has a structural fix above: a derived schema version, screens cut off from the replica, and the sync rule carried by the mutation type (whole-document put or delete only).

**Grafted from server-authoritative:** required core macros with a candidate-to-food completion step, nightly backups to iCloud Drive, and the photo fallback for barcodes.

**Fixed from the judge's review:** recipe nutrients no longer treat missing as zero. Workout kcal are net of resting burn, so they never double credit BMR. Screens can no longer import the replica's internals.

**Rejected:** a server-rendered htmx UI (round trip per tap), photo-only barcode scanning, Python on the server (the nutrient math and schemas would exist twice), and `max(Health, manual)` for burn (drops untracked workouts).

## Tradeoffs accepted

- We accept a hand-written sync layer of about 300 lines, plus a fault-injecting simulation test, in exchange for instant logging and full offline use.
- We accept a generic JSON document table on the mini with no SQL foreign keys, in exchange for one registry driving validation, sync and the phone's tables. Document schemas evolve additively only.
- We accept diverging from stash's Python conventions, in exchange for one copy of the math.
- We accept that food edits do not flow into recipes and saved meals unless Dylan accepts the prompt, in exchange for stable history.
- We accept that a late weigh-in nudges past days' targets through the trend, in exchange for not storing targets.
- We accept no app-level auth. The tailnet and the loopback bind are the perimeter.

## Phasing

Each phase ends with a check on the real phone.

1. **Scaffold.** Repo, lint, tests, Hono serving a placeholder PWA, launchd, `tailscale serve`, Add to Home Screen. A device spike for camera access in standalone mode. Done when the Home Screen app opens in airplane mode and scans a barcode to digits on screen.
2. **MVP.** Foods, entries, goals, profile. Sync and its simulation. Diary with meals, totals and remaining. Recents, library search, quick add, edit and delete with undo, create a food, scan to Open Food Facts to log, USDA search, the goal calculator (BMR, TDEE, rate, macro split), nightly backups. Done when Dylan logs a real day, including one entry made in airplane mode that reaches `fuel.db`.
3. **Reuse.** Recipes, saved meals, copy meal and copy day, the food-edit update prompt.
4. **AI quick log.** Text first, then label photo (which also fills the "barcode not found" gap), then plate photo.
5. **Body and workouts.** Weigh-ins, trend chart, weekly rate, projected goal date, MET workouts, the budget policy.
6. **Water and fasting.**
7. **Refinements.** Adaptive TDEE suggestion once weeks of data exist, an inbox for unknown barcodes scanned offline, a restore drill.

## Next implementation step

Write `domain/kinds.ts` with the `food` and `entry` kinds, `server/store.ts` sync over an in-memory database, and `client/replica.ts` over fake-indexeddb. Then make the sync simulation (dropped requests, dropped responses, duplicate delivery) pass before any screen exists.
