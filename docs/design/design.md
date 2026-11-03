# fuel design

Status: approved 2026-10-28 (phone-first). Wearable burn import deferred the same day. Phases 1 to 6 are built. Open questions are in [open-questions.md](open-questions.md).

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

Document shapes are zod loose objects at every depth. A field a newer app adds survives an older cached app that reads the document and writes it back. Drafts the app rebuilds from a form keep the stored document's unknown top-level fields.

The phone's IndexedDB version is derived, not hand-bumped. `SCHEMA_HISTORY` is an append-only array of derived table specs, and the version is its length. A test fails when the current derived spec differs from the last entry. (Graft from the judge's review.)

### Food model

- **One basis per food.** A food has `unit` (`g`, `ml` or `portion`) and nutrients per 100 g, per 100 ml or per portion. The `per` amount is derived from the unit, never stored, so the two cannot disagree. `nutrientsFor(food, quantity)` is the only food-times-quantity math. Grams and millilitres never convert.
- **Servings** are named amounts in the food's unit ("1 large egg" is 50 g). A `Quantity` is `{ amount }` or `{ serving, count }` with the serving copied in, so it never needs a lookup.
- **Required nutrients.** A library food must have kcal, protein, carbs and fat. Fiber, sugar and sodium are optional, and unknown is never zero. External data (Open Food Facts, USDA, AI) arrives as a `FoodCandidate` with partial nutrients. `completeFood()` either returns a `Food` or names the missing fields, and the confirm sheet asks for them. An incomplete import cannot reach the diary. (Graft from server-authoritative.)
- **Quick add** entries need only kcal. Totals list them as incomplete for macros ("protein: at least 92 g").
- **History is stable.** Entries, recipe ingredients and saved-meal items hold a `FoodSnapshot` by value. Editing a food never changes a past day. A recipe can never contain itself, because it holds values, not references. After a food or recipe edit the app asks "also update 2 recipes and 1 saved meal?" and re-snapshots them only on yes, in one commit with an undo. The update carries through recipes held in other recipes and saved meals, so a saved meal of chili updates when the beef in the chili does. Each recipe is worked out once, so recipes holding each other's older snapshots cannot loop. An item now measured in another unit keeps its old snapshot, because its amount would change meaning (200 g is not 200 portions). Diary entries are never re-snapshotted.
- **Recipe nutrients.** An optional nutrient in a recipe is known only when every ingredient reports it. (Fix from the judge's review. The local-first sketch summed missing values as zero.) The core four are always known, because library foods require them.
- **Recipes log as snapshots.** A recipe has ingredients, a number of servings and an optional cooked weight. It logs as a snapshot whose origin is the recipe. With a cooked weight it is measured in grams of the cooked dish, with "1 serving" being the weight shared by the servings. Without one it is measured in portions, one portion being one serving. Recents and search offer a recipe's current version, like a library food's.
- **One way into the diary.** Recipes, saved meals and copied meals all become `Ingredient[]` and go through `intents.logItems`. Only two intents make entries otherwise: `importAndLog` logs the food it imports in the same commit, and `copyDay` keeps each copy's own meal.
- **Barcodes** normalize to 13 digits with a verified check digit.
- **Units.** Body weight is stored in kg and shown in lb. Open Food Facts and USDA unit quirks are normalized in their adapters only.

### Water and fasting

Water is one `water` document per drink, so drinks added offline on two phones both count. The daily goal is a field of the effective-dated goal, stored in ml and shown in fl oz like weight in lb, and saved from the Goal screen. Goals without one use 64 fl oz.

A `fast` document holds a start and a target. Its start is the phone's clock at the tap, so a fast started offline keeps its real start. Its end is a separate `fastEnd` document, written once and never rewritten. Per separate-before-serializing-shared-state, a phone holding an older open copy of a fast can rewrite the fast, such as when changing its target, but never its end, so a finished fast cannot reopen. Two phones that end the same fast offline leave two ends, and the earliest counts. The server still stores documents without editing them. The fasting state is derived from the documents with no stored flag:

```
idle      no open fast
fasting   one open fast
overlap   two or more open fasts, from two phones that each started one offline
```

The timer runs from the earliest open start. "End fast" writes an end for every open fast, which settles an overlap, and its undo deletes only those ends. History merges fasts whose times overlap into one session. A streak counts local days that finished a fast on target, by the day it ended, and today does not break it before it is over. The next fast starts with the latest fast's target, 16 hours before any.

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

The replica's `commit` parses every document against its kind's schema before it writes, and throws `InvalidDocument` with nothing written. An edit the mini would reject fails on the phone when it is made. Before, it reached the outbox, the mini refused it, and the next sync deleted it from the phone without a word.

The only real conflict is two devices editing the same document while one is offline. The later arrival wins. 
iOS gives web apps no background sync. Sync runs on app start, after each write (debounced), on returning to the foreground, on the `online` event, and every 60 seconds while the app is open.

Screens never touch the replica's `commit` or the outbox. `FuelProvider` exposes read views and `Intents` only, and an eslint import rule makes `screens/` importing `replica.ts` a build error. (Fix for the judge's "importable internals" flag.)

### Calorie budget and workouts

All pure, in `domain/goals.ts`, `domain/body.ts` and `domain/burn.ts`.

```
weight    = the trend weight on that day, or the profile weight before the first weigh-in
bmr       = Mifflin-St Jeor(profile, weight)
goal      = the goal in effect on that day (goals are effective-dated)
policy    = { kind: 'activity-level', level } | { kind: 'eat-back-workouts', fraction }

activity-level:     target = bmr × multiplier + rate adjustment
                    workouts are recorded but do not change the budget
eat-back-workouts:  target = bmr × 1.2 + rate adjustment + fraction × Σ workout net kcal
manual override:    replaces bmr × multiplier + rate adjustment; eat-back still adds workouts
remaining = target − eaten kcal
```

The default is `activity-level`, which gives a steady daily target. The goal stores the activity level, and the multiplier comes from the standard table (1.2 to 1.9). Changing the level or the policy saves a new goal, so past days keep theirs. Eat-back stores `fraction` from 0 to 1, shown as a percent, 100% by default. The weekly rate is stored in kg and converted at 3500 kcal per lb, so losing 1 lb a week is exactly 500 kcal a day. A goal may set a manual kcal target instead, and its macros are a percent split or grams. A percent split applies to the whole target, eaten-back workouts included. The Goal screen explains each policy in one sentence, and the diary summary reads "goal + workouts − food" when workouts count.

BMR reads the trend weight on the day. Days before the first weigh-in use the profile weight, which is what they were budgeted with before phase 5, so starting to weigh in leaves them alone. A late weigh-in moves the trend, and with it the targets of the days after it, slightly. A single weigh-in is its own trend, so "the latest weigh-in" needs no separate fallback.

A workout is one `workout` document. It stores its net kcal, `(MET − 1) × kg × hours`, and the weight it was worked out at, so later weigh-ins never rewrite past burn. Editing a workout keeps that weight. Net kcal leave out the resting burn already in BMR. The 1.2 sedentary baseline covers digestion and light daily movement, so a logged workout is extra on top of it and never counted twice. Activities come from a table of 30 MET values from the 2024 Adult Compendium of Physical Activities, checked against the published tables on 2026-10-28. A workout stores its label and MET, so it never needs the table again, and a newer app's activity still parses on an older one. A custom workout takes the burn as a machine or calculator reports it, and the app subtracts the same resting share, `kg × hours`, to keep the one rule. Dylan wears an Apple Watch but does not trust its calorie numbers, so no device burn enters the budget.

### Weight trend

A weigh-in is one document per day, `w:<date>`, so a second weigh-in that day replaces the first and the latest edit wins. The trend follows the Hacker's Diet. The first weigh-in seeds it, each later weigh-in moves it a tenth of the way, `trend += 0.1 × (weight − trend)`, and a day with no weigh-in carries it unchanged. Nothing about the trend is stored.

The weekly rate is the least-squares slope of the trend over the last 14 days. It needs a trend that spans all 14 days and at least 7 weigh-ins in them. Before that the app says "not enough data" rather than project from one or two readings. The goal weight is an optional field of the goal, so it is effective-dated like the rest. The projected date is when the trend reaches it at the current rate. Within about half a pound counts as reached, a rate under 0.1 lb a week projects nothing ("holding steady"), and a trend heading the wrong way says so.

The Weight sheet charts scale weigh-ins as gray dots under the trend as a blue line, over 30, 90 or 365 days, in inline SVG. A green goal line shows when the goal is near the data, so a distant goal never flattens the trend. A touch scrub reads out the day's trend and scale weight, and the list of weigh-ins under the chart is its table view.

### AI quick log

On the Add screen Dylan describes a meal, or picks a photo of a plate or a nutrition label. The phone shrinks a photo to 1568 px on the long edge as a JPEG of a few hundred KB, and sends it with his foods as hints: up to 60 names and keys, recents first. `POST /api/ai/parse` asks Claude, writes nothing, and answers drafts for a description or a plate, or a `FoodCandidate` for a label.

A draft is one food: a name, the amount as far as the model could tell it, nutrients for the whole amount, a confidence, and the key of one of his foods when the model judged the item to be that food. The amount is a count, grams for food and millilitres for drinks, and any of them may be unknown. The model picks the match from the numbered hints, because a name search cannot tell "coffee with oat milk" from his oat milk. The phone resolves the key against its own copy, and also offers up to two foods that the draft's name finds.

A draft logs as the AI's estimate or as one of his foods (`domain/quicklog.ts`):

- The estimate is a one-off food measured by the weight or volume the model gave, so changing the amount scales its nutrients. A counted piece becomes a serving, so "3 slices" can become 2.
- His food logs his own nutrients. With no amount said, it logs the amount he last logged, so "my usual oats" is his usual jar.
- A count becomes his serving only when it agrees with the model's weight to within 35%. "1 bowl, 80 g" of oats whose serving is a 250 g jar logs 80 g.
- Grams never become millilitres.

The review sheet lists the drafts under their totals. Each row edits its amount, swaps between the estimate and his foods, or is removed. Nothing is logged until he confirms. Then every row goes through `intents.logItems` in one commit, into the one meal picked at the foot of the sheet. A label opens the confirm sheet, where `completeFood` asks for any core nutrient the model could not read. When a barcode lookup misses, Scan offers **Photograph the label**, and the confirmed food keeps the scanned barcode, so the next scan finds it in the library.

`server/ai.ts` calls `client.beta.messages.create` with structured output from zod schemas, at low effort, with `fallbacks: "default"` so a classifier refusal is retried on another model by the API. It reads the stop reason before the content, then parses the reply with the same schema. A failure carries its reason in the error body:

| Reason | Status | When |
|---|---|---|
| `ai_unconfigured` | 503 | no `ANTHROPIC_API_KEY` on the mini |
| `ai_unavailable` | 502 | the API is out of reach or answers an error, after one retry |
| `ai_timeout` | 504 | no answer within 25 seconds |
| `ai_refused` | 422 | the model declined, fallback included |
| `ai_unreadable` | 502 | the reply does not fit the schema, or was cut off |
| `ai_nothing_found` | 422 | no food in the input, or no readable label |

The model is `FUEL_AI_MODEL`, by default `claude-opus-5-5` at low effort. The claude-api guidance is to use the current Opus unless Dylan names another model, and to lower effort before switching to a smaller model. Low effort is its quickest setting, and structured extraction keeps its quality there. Whether a Haiku or Sonnet model is fast and accurate enough to replace it is open question 5. `scripts/ai-smoke.mjs` answers it once the key lands.

AI needs the mini. The phone turns quick log off, and says why, while the browser is offline or the last sync could not reach the mini. It never queues a request. The route's reasons reach the screen through `Online<T, Why>`, the same result type as search and lookup.

### Deferred: wearable burn import

Importing measured burn is out of scope until Dylan has a wearable he trusts (decided 2026-10-28). When it lands, it adds a third policy, `{ kind: 'measured', fraction }` with `target = bmr × 1.1 + fraction × device active energy`, a server-written `health` kind (one line in `KINDS`), and an ingest route. The candidates' Shortcut contract (latest `as_of` wins per metric and day, numbers coerced from text, raw payloads logged) is the starting point. See [candidates/local-first/design.md](candidates/local-first/design.md). Nothing in the current shape blocks it.

### Module map

```
src/domain/     pure; compiled with no DOM and no Node types
  ids.ts units.ts nutrients.ts food.ts diary.ts library.ts reuse.ts goals.ts body.ts burn.ts habits.ts quicklog.ts kinds.ts
src/protocol.ts zod schemas for every HTTP body
src/server/     main.ts routes.ts store.ts foods.ts off.ts usda.ts upstream.ts ai.ts backup.ts
src/client/     main.tsx replica.ts sync.ts intents.ts views.ts api.ts scanner.ts photo.ts screens/
test/           domain units, adapter fixtures, routes, sync simulation, schema history pin
scripts/        run.sh, com.dylansavage.fuel.plist, restore.sh, ai-smoke.mjs
```

Logging a recent food traces `screens/Diary.tsx` to `intents.ts` to `replica.ts`, with the math in `domain/diary.ts`. The server side is `routes.ts` to `store.ts`. Recipes, saved meals and the food-edit refresh live in `domain/reuse.ts`, water and fasts in `domain/habits.ts`, weigh-ins and the trend in `domain/body.ts`, workouts in `domain/burn.ts`, and AI drafts in `domain/quicklog.ts`.

The tab bar keeps four tabs: Diary, Add, Scan and Goal. Recipes and saved meals are shelves inside Add, beside Recent, where logging starts. Water, the fast timer and weight are tiles on the Diary under the day's summary. The fasting tile shows only on today, where the weight tile takes the row below the other two and adds a 30-day trend line. The weight tile has a one-tap Weigh in and opens the Weight sheet, which the Goal screen's Profile group opens too. Workouts are a section after Snacks, laid out like a meal.

### HTTP surface

| Route | Purpose |
|---|---|
| `POST /api/sync` | the only write path for user data: push mutations, pull changes |
| `GET /api/foods/search?q=` | USDA (when `USDA_API_KEY` is set) and Open Food Facts text search through search-a-licious; 502 only when every source fails |
| `GET /api/foods/lookup/:ref` | barcode (`gtin:`) or USDA (`usda:`) lookup, cached on the mini |
| `POST /api/ai/parse` | a description or photo to drafts, or a label to a food candidate; writes nothing; 503 `ai_unconfigured` without a key |
| `GET /healthz`, `GET /*` | smoke check with the build a phone last reported; the built PWA |

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
- We accept that a late weigh-in nudges past days' targets through the trend, in exchange for not storing targets. Days before the first weigh-in keep the profile weight, so they do not move.
- We accept that the trend holds still across days with no weigh-in, rather than drawing a line between weigh-ins. After a long gap it takes a couple of weeks of weigh-ins to catch up, and the rate reads fast while it does.
- We accept no app-level auth. The tailnet and the loopback bind are the perimeter.
- We accept sending the names of up to 60 of Dylan's foods to Anthropic with each AI request, in exchange for matches a name search cannot make.

## Phasing

Each phase ends with a check on the real phone.

1. **Scaffold.** Repo, lint, tests, Hono serving a placeholder PWA, launchd, `tailscale serve`, Add to Home Screen. A device spike for camera access in standalone mode. Done when the Home Screen app opens in airplane mode and scans a barcode to digits on screen.
2. **MVP.** Foods, entries, goals, profile. Sync and its simulation. Diary with meals, totals and remaining. Recents, library search, quick add, edit and delete with undo, create a food, scan to Open Food Facts to log, USDA search, the goal calculator (BMR, TDEE, rate, macro split), nightly backups. Done when Dylan logs a real day, including one entry made in airplane mode that reaches `fuel.db`.
3. **Reuse.** Recipes, saved meals, copy meal and copy day, the food-edit update prompt. Built 2026-10-28.
4. **AI quick log.** Text first, then label photo (which also fills the "barcode not found" gap), then plate photo. Built 2026-10-28, tested against hand-written replies until the API key lands.
5. **Body and workouts.** Weigh-ins, trend chart, weekly rate, projected goal date, MET workouts, the budget policy. Built 2026-10-28.
6. **Water and fasting.** Built 2026-10-28.
7. **Refinements.** Adaptive TDEE suggestion once weeks of data exist, an inbox for unknown barcodes scanned offline, a restore drill.

## Next implementation step

Write `domain/kinds.ts` with the `food` and `entry` kinds, `server/store.ts` sync over an in-memory database, and `client/replica.ts` over fake-indexeddb. Then make the sync simulation (dropped requests, dropped responses, duplicate delivery) pass before any screen exists.
