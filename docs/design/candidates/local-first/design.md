# fuel, candidate 2: local-first with sync

## Problem

Dylan wants a MyFitnessPal replacement that he uses many times a day on his iPhone, often where the network is bad (restaurants, the gym). It is a Home Screen PWA. The store of record is SQLite on the Mac mini, reached over Tailscale. The mini also holds the Anthropic key and is the only place an iOS Shortcut can send Apple Health data.

Three things make the shape non-obvious.

1. Logging must feel instant and keep working when the mini or the tailnet is unreachable. So the phone needs its own working copy of the data and a way to merge it back.
2. There are several writers. The PWA writes, a second browser might write, and the Health Shortcut writes and resends the same totals many times a day.
3. Diary history must stay stable when a food or recipe is edited later, and nutrient math must live in one place.

Constraints this design honors, from the grounding: PWA only (no Xcode, no native), SQLite on the mini as the durable store, one launchd service like stash, HTTPS through `tailscale serve`, the API key never on the phone, TypeScript strict or Python.

## Usage (caller's view)

### What Dylan sees

- He opens fuel from the Home Screen. Today's diary renders from the phone's replica on the first frame, online or not.
- He taps a recent food. It logs with last time's quantity into the meal for the current hour, and an undo toast appears. Nothing waits for the network. When offline, a small "2 waiting" badge counts unsynced changes.
- He scans a barcode. Decoding runs on the phone. A product already in his library logs with no network at all. An unknown product is looked up on Open Food Facts through the mini, and he confirms it. Unknown and offline offers quick add or create-by-hand.
- He searches. Recents, his foods, recipes and saved meals answer instantly from the replica. USDA results appear below them when the mini is reachable.
- AI quick log and external search need the mini. When it is unreachable the UI says so in place, with no spinner.
- The Health Shortcut posts burn to the mini on a schedule. The next time the app syncs, the day's remaining calories include it.

| Action | Mini reachable | Mini unreachable |
|---|---|---|
| Open app, browse any day | instant, from replica | same |
| Log recent or library food, recipe, saved meal, quick add, copy meal/day | instant, synced about a second later | instant, queued, "N waiting" badge |
| Scan a product already in the library | instant | instant |
| Scan an unknown product | OFF lookup, confirm, logged | quick add or create by hand |
| External search | shown below local results | "online results unavailable" row, local results still shown |
| AI quick log | drafts to confirm | disabled with the reason |
| Weigh-in, water, fast, workout | instant | instant, queued |
| Health burn | appears after the Shortcut runs and the app syncs | last synced value |

### Developer README

```
npm install
npm run dev        # vite on :5173 proxying /api to the server on :8787, temp database
npm test           # vitest: domain math, adapter fixtures, routes, sync simulation, registry pin
npm run build      # dist/client (PWA) and dist/server
launchctl kickstart -k gui/$(id -u)/com.dylansavage.fuel   # deploy = build + restart
```

### Call sites

A diary screen. Reads are live queries over the replica. Writes are intents.

```tsx
function DiaryScreen({ date }: { date: LocalDate }) {
  const day = useLive((r) => dayView(r, date), [date]);              // DaySummary
  const recent = useLive((r) => recentFoods(r, now(), 12), []);
  const { intents } = useFuel();
  if (!day) return null;                                              // first frame only
  return (
    <>
      <Remaining kcal={day.remainingKcal} burn={day.burn} eaten={day.eaten} />
      {recent?.map((f) => (
        <RecentRow
          food={f}
          onTap={() => intents.logItems([{ food: f.food, quantity: f.lastQuantity }], { date, meal: mealAt(hourNow()) })}
        />
      ))}
    </>
  );
}
```

The scan flow. The type of `api.lookup` forces the offline branch.

```ts
async function onScan(video: HTMLVideoElement, slot: Slot, signal: AbortSignal) {
  const gtin = await scanBarcode(video, signal);
  const known = await read.foodByBarcode(gtin);
  if (known) return intents.logItems([{ food: snapshotOf(known), quantity: defaultQuantity(known) }], slot);

  const res = await api.lookup({ kind: 'gtin', gtin });
  if (!res.ok) return show({ sheet: 'unknown-offline', gtin });        // quick add or create by hand
  if (res.value === null) return show({ sheet: 'create-food', gtin }); // or AI from a label photo
  show({ sheet: 'confirm', candidate: res.value });                    // then intents.logCandidate(candidate, qty, slot)
}
```

Process wiring on the mini.

```ts
const cfg = Config.parse(process.env);
const store = openStore(join(cfg.FUEL_DATA_DIR, 'fuel.db'));
const app = buildApp({
  store,
  foods: createFoodSources({ off: createOffClient(...), usda: createUsdaClient(...), cache: store.cache, now }),
  ai: cfg.ANTHROPIC_API_KEY ? createAiParser({ client: new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY }), model: cfg.FUEL_AI_MODEL }) : null,
  staticDir: cfg.FUEL_STATIC_DIR,
  now,
});
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: cfg.FUEL_PORT });
```

On the phone, `main.tsx` is the only place the sync port is visible.

```ts
const { replica, port } = await openReplica();
const sync = startSync(port, replica);
render(<FuelProvider replica={replica} intents={createIntents(replica, now)} sync={sync.status} />, root);
```

The Health Shortcut posts this. The full contract is under [Health Shortcut ingest contract](#health-shortcut-ingest-contract).

```json
{ "v": 1, "as_of": "2026-10-28T21:00:04-07:00",
  "days": [ { "date": "2026-10-28", "active_energy": { "value": 512.4, "unit": "kcal" }, "steps": 9310 },
            { "date": "2026-10-27", "active_energy": { "value": 701.0, "unit": "kcal" }, "steps": 12001 } ] }
```

## Shape

### Stack

TypeScript strict everywhere, because in a local-first design the phone runs the same validation and math as the server. Each choice below is load-bearing against the named alternatives.

| Concern | Choice | Over | Why |
|---|---|---|---|
| Language | TypeScript strict on both sides | Python server (stash's convention) with a TS client | The phone parses every doc it stores and computes every total offline. With Python on the server, the doc schemas and the nutrient math would exist twice and drift (hand-synced list). One language gives one zod schema per doc that both boundaries use. |
| Server framework | Hono on `@hono/node-server` | Fastify, Express, bare `node:http` | Six routes and static files. Hono is small, typed, and `app.request()` runs route tests in-process. Fastify's plugin and schema system solves problems this server does not have. |
| SQLite driver | `better-sqlite3`, raw SQL in one file | `node:sqlite`, Drizzle, Kysely | Synchronous, so a push batch is one transaction that cannot interleave with another request. That makes "rev order equals commit order" structural. `node:sqlite` loads on this mini's Node 22.22.3 but prints an ExperimentalWarning (observed), so it waits. A query builder earns its keep across many tables; this server has one doc table and five small ones. Swapping drivers later touches only `store.ts`. |
| Phone store | Dexie 4 on IndexedDB | SQLite-WASM on OPFS, `idb`, RxDB, PouchDB | Dexie's `liveQuery` re-renders screens on local writes and sync merges alike, with no event bus. SQLite-WASM would give the same SQL on both sides but adds about 1 MB of wasm and a worker for sync access handles, and its track record in iOS standalone mode is thinner (my understanding, unverified). RxDB and PouchDB bring their own replication model. |
| Sync | Hand-rolled outbox and pull protocol, about 300 lines (estimate) | Replicache/Zero, PowerSync, ElectricSQL, TinyBase, CouchDB with PouchDB | The off-the-shelf engines want Postgres, a hosted service, or a cell-level CRDT model. CouchDB would replace SQLite as the store of record, which is decided. The protocol below is small because the domain is mostly append-only. |
| UI | Preact with hooks | React, Svelte, vanilla | React-shaped code at a fraction of React's runtime. Cold start from the Home Screen is the moment that matters. |
| PWA | Vite with `vite-plugin-pwa` (Workbox `generateSW`, `registerType: 'prompt'`) | Hand-written service worker | Precache manifests and update prompts are where hand-written workers go stale. The worker caches only the shell and the zxing wasm; data never goes through it. |
| Barcode | `barcode-detector` (native `BarcodeDetector` when WebKit has it, zxing-wasm otherwise), wasm self-hosted | `html5-qrcode`, `@zxing/browser`, Quagga2 | Uses the native path for free if WebKit ships it. Self-hosting the wasm (its default is a CDN) makes scanning work offline. |
| Validation | zod 4 on both sides | hand-written guards | The same schemas parse wire data, stored rows, and the AI's structured output (`zodOutputFormat`). |
| Tests | vitest, fake-indexeddb, fast-check, Playwright WebKit | | Unit and fixture tests for the domain, a seeded simulation for sync, one browser pass with the network cut. |

### Documents and the kind registry

Every piece of user state is a document of one kind. `src/domain/kinds.ts` is the one list of kinds (per model-the-domain). Each entry names the zod schema, the writer class, and whether docs are dated.

```ts
export const KINDS = {
  food: doc(Food, 'client', ['*doc.barcodes']),
  recipe: doc(Recipe, 'client'),
  savedMeal: doc(SavedMeal, 'client'),
  entry: datedDoc(Entry, 'client'),
  exercise: datedDoc(Exercise, 'client'),
  water: datedDoc(WaterLog, 'client'),
  fast: doc(Fast, 'client', ['doc.startedAt']),
  weighIn: datedDoc(WeighIn, 'client'),
  goal: doc(Goal, 'client', ['doc.effectiveFrom']),
  profile: doc(Profile, 'client'),
  health: datedDoc(HealthDay, 'server'),
} as const;
```

From this one object the code derives the `DocOf<K>` and `ClientKind` types, the server's push validation, the phone's Dexie table spec, and `ReplicaReader.onDate`. A kind cannot be marked dated unless its schema has a `date` field, because `datedDoc`'s type bound rejects it (checked with a negative compile test). Adding storage for a feature is one line here, plus the compile errors it causes. The server needs no migration because every kind lives in one table.

### Food model

- **Canonical basis.** A food has `unit` (`g`, `ml` or `portion`) and `nutrients` for `per` units. External g/ml data is normalized to `per = 100` at the adapter boundary. Portion foods use `per = 1`. One formula, `nutrientsFor(food, q) = scale(food.nutrients, baseAmount(q) / food.per)`, is the only food-times-quantity math in the system.
- **Servings.** Named servings carry their amount in the food's unit ("1 large egg" = 50 g).
- **Quantity.** A discriminated union, either `{ amount }` or `{ serving, count }`, where `serving` is a copy of the Serving, amount included. A quantity never needs a lookup to resolve. An entry with no quantity basis cannot be built.
- **Unknown vs zero.** kcal is required. Every other nutrient is `undefined` when unknown, never 0. `Totals` sums with unknown as 0 and records the key in `incomplete`, so the UI can print "at least 1,840 mg sodium". The nutrient list exists once (`NUTRIENTS`), and the schema is checked against it with `satisfies` (verified by adding a key and watching the compile fail).
- **History stability by value.** An entry holds a `FoodSnapshot` by value. The snapshot carries name, unit, per, nutrients, servings, and an `origin` used only for grouping. Editing or archiving a library food never changes a past day. Recipe ingredients and saved-meal items are the same `Ingredient = { food: FoodSnapshot, quantity }` shape.
- **Why snapshots inside recipes too.** In a replicated store, an invariant that spans documents ("no recipe contains itself", "the referenced food exists") cannot be enforced, because each replica validates against its own partial view. Two offline edits could close a cycle that neither replica saw. Because recipes hold values, a recipe can never contain itself, never forms a cycle, and computes on any replica with no other doc present. The cost is that food edits do not flow into recipes on their own. `intents.refreshFromLibrary` re-snapshots on request, and the food editor offers "also update 2 recipes and 1 saved meal?" (phase 2).
- **Barcodes.** `Gtin` is normalized to 13 digits (UPC-A gains a leading 0) with the check digit verified, so one product has one key whatever the decoder reported.
- **Units.** Body weight is `Kg` (branded), converted to lb at display using `Profile.display`. Energy is `Kcal`. Health and OFF unit quirks are normalized in their adapters and nowhere else (per boundary-discipline).

### Who writes what

Each piece of state has one owner (per separate-before-serializing-shared-state).

| State | Only writer | Everyone else |
|---|---|---|
| `food`, `recipe`, `savedMeal`, `entry`, `exercise`, `water`, `fast`, `weighIn`, `goal`, `profile` docs | a client replica, through `/api/sync` pushes | the server stores them and never edits them |
| `health` docs | the server's ingest route, on behalf of the Shortcut | phones read them; a pushed `health` mutation is rejected, and the client's `Change` type cannot even express one |
| `rev`, `epoch`, `client.last_mutation_id` | `DocStore` | phones read them in responses |
| outbox, cursor, clientId | that replica | the server reads them in requests |
| `lookup_cache`, `ingest_log`, `rejection` | the server | nobody, never synced |
| totals, remaining, trend, recents, fast state | nobody | derived by pure functions on read |

Random ids are minted only on the client (`crypto.randomUUID()` in `intents.ts`), so creates never collide. Day-keyed singletons use deterministic ids (`w:<date>`, `g:<date>`, `h:<date>`, profile `me`), so logging a weight twice converges to one doc (per make-operations-idempotent). Water is one row per drink, never a per-day counter, so two offline replicas adding water both count. Weight has two writers (manual and Health) in two kinds, merged at read time by `dailyWeights` with manual winning on a shared day.

### Sync protocol

The model is **whole-document writes, ordered by arrival at the server.** The phone queues writes in an outbox and pushes them. The server applies them in arrival order and stamps each write with a global `rev`. Phones pull everything above their cursor. Documents are the truth. Mutations are transport only and vanish once acknowledged.

**Push (inside `DocStore.sync`, one IMMEDIATE transaction).**

1. Load `last = client.last_mutation_id` (0 for a new client).
2. For each mutation with `id > last`, in ascending order, check it. The kind must exist and be client-writable, the doc must pass `parseDoc(kind)`, and `doc.id` must equal `docId`. If it passes, upsert `doc(kind, id)` with `rev = MAX(rev) + 1` (body NULL for a delete). If it fails, record a rejection. Either way set `last = id`.
3. Store `last`. A replayed request finds nothing above `last`, so a lost response is safe to retry.

**Pull (same request).** `from = req.epoch === epoch ? req.cursor : 0`. Return up to 1000 rows with `rev > from` in rev order, plus `more`. For each rejection, return the server's current copy of that doc so the phone can undo its optimistic write.

**Apply on the phone (`SyncPort.apply`, one IndexedDB transaction).**

1. Delete outbox rows at or below `lastMutationId`.
2. Write each rejection's `current`.
3. For each change, skip it when an outbox row for that doc is still pending. Otherwise write `{ id, rev, doc }`, or delete on a tombstone.
4. Store the cursor and epoch.

Rule 3 is the whole rebase story. A pending local write reaches the server after every change already pulled, so it wins there by arrival order. Keeping it locally is exactly what the server will end up holding. Rule 3 is correct only because every mutation is a whole-document put or delete. That is why the design has no increment-style mutations.

**Why rev order is trustworthy.** The driver is synchronous and the process is single-threaded, so transactions never interleave. `MAX(rev)` never decreases because rows only change by getting a higher rev and deletes keep their row as a tombstone. A pull can never skip a rev that commits later.

**Restores.** Restoring a backup regenerates `epoch` (`scripts/restore.sh`). A phone with an old epoch gets a full pull from 0. Every local row still at `rev = null` after that pull, with no pending outbox row, exists on the phone but not on the restored server, so the phone re-pushes it. The phone is a second copy of everything, which turns a lost day of server data into a recoverable one.

**Conflict story.**

- Phone and Shortcut never conflict. They write disjoint kinds.
- Two creates never conflict. Ids are random UUIDs.
- Same-day singletons converge. Weigh-in, goal and Health use deterministic ids.
- Health resends never conflict. `mergeHealthDay` keeps the later `asOf` per metric, which is commutative and idempotent.
- Two replicas editing the same document is the only real conflict. The later arrival wins the whole document. With one human it takes two devices editing the same entry, one of them offline, for this to happen. Fast state handles its version explicitly (`FastStatus.overlap`, resolved by ending both).

**Triggers.** iOS gives PWAs no Background Sync, so sync runs only while the app is open. The triggers are app start, every commit (debounced 300 ms), returning to the foreground, the `online` event, and every 60 s while visible. `navigator.locks` keeps it single-flight. Failures back off to 5 minutes and change no data.

### SQLite schema (mini)

Full DDL is in `sketch/src/server/store.ts`. In summary:

```sql
doc(kind, id, rev UNIQUE, body JSON | NULL, written_by, written_at)  PRIMARY KEY (kind, id)
client(id PRIMARY KEY, last_mutation_id, first_seen_at, last_seen_at, user_agent)
rejection(client_id, mutation_id, at, reason, mutation)              -- debugging only
meta(key PRIMARY KEY, value)                                          -- epoch
lookup_cache(source, key, fetched_at, status, body)                   -- raw OFF/USDA, never synced
ingest_log(seq, at, body, result)                                     -- last 200 Shortcut payloads
```

All tables are `STRICT`, WAL mode. The file lives in `~/Library/Application Support/fuel/fuel.db`, outside the git checkout. Backups use better-sqlite3's online backup to a temp file renamed to `fuel-<date>.db`, hourly-checked, keeping 30.

### Client store schema (phone)

Dexie database `fuel`, version `CLIENT_DB_VERSION`, spec derived by `dexieStores()`.

```
food:      'id, *doc.barcodes'        entry:    'id, doc.date'      health:  'id, doc.date'
recipe:    'id'                       exercise: 'id, doc.date'      goal:    'id, doc.effectiveFrom'
savedMeal: 'id'                       water:    'id, doc.date'      profile: 'id'
fast:      'id, doc.startedAt'        weighIn:  'id, doc.date'
outbox:    'mutationId'               meta:     'key'               (clientId, nextMutationId, cursor, epoch, reseedPending)
```

Kind rows are `{ id, rev: number | null, doc }`. `rev = null` means written here and not yet echoed back. Library search filters the small library in memory, so there is no text index. `test/registry.test.ts` pins the derived spec per `CLIENT_DB_VERSION`, so changing an index without bumping the version fails the build instead of failing on the phone.

### HTTP surface

The server binds `127.0.0.1:8787`. `tailscale serve --bg 8787` terminates HTTPS for `dylans-mac-mini.tail82aa2c.ts.net` and is the only network path in, so the tailnet is the perimeter and there is no app-level auth. The PWA is served from the same origin, so there is no CORS.

| Route | Request | Response | Notes |
|---|---|---|---|
| `POST /api/sync` | `SyncRequest { clientId, epoch, cursor, mutations[] (max 500) }` | `SyncResponse { epoch, lastMutationId, rejected[], changes[], cursor, more }` | the only write path for user data |
| `GET /api/foods/search?q=&limit=` | query | `{ hits: SearchHit[] }` | USDA in the MVP, OFF text search once its endpoint is verified |
| `GET /api/foods/lookup/:ref` | `gtin:<digits>` or `usda:<fdcId>` | `{ kind: 'found', candidate } \| { kind: 'not_found' }` | OFF barcode, USDA detail with portions |
| `POST /api/ai/parse` | `{ kind: 'text', text } \| { kind: 'photo', subject: 'label' \| 'plate', mediaType, base64 }` | `AiResult` = drafts, label candidate, or unreadable | 503 `ai_unconfigured` without a key; writes nothing |
| `POST /api/health/ingest` | `HealthIngestRequest` | `{ ok: true, stored, unchanged } \| { ok: false, error }` | always 200 |
| `GET /healthz` | | `{ ok, epoch, rev, dbBytes }` | smoke checks |
| `GET /*` | | built PWA | `index.html` and `sw.js` no-cache, hashed assets immutable |

Request and response schemas are in `sketch/src/protocol.ts`, shared by both sides. `client/api.ts` unwraps responses into domain types (`SearchHit[]`, `FoodCandidate | null`, `AiResult`) wrapped in `Online<T>`, whose failure reasons (`offline`, `unavailable`, `bad_response`) the screen must handle.

### Health Shortcut ingest contract

```
POST https://dylans-mac-mini.tail82aa2c.ts.net/api/health/ingest
Content-Type: application/json
{
  "v": 1,
  "as_of": "<Current Date, ISO 8601 with offset>",
  "days": [                                   // 1 to 7 days; send today and yesterday
    { "date": "yyyy-MM-dd",
      "active_energy": { "value": <number>, "unit": "kcal" | "Cal" | "kJ" },   // cumulative for that calendar day
      "steps": <number>,                                                       // optional
      "weight": { "value": <number>, "unit": "lb" | "kg" } }                   // optional, latest sample that day
  ]
}
-> 200 { "ok": true, "stored": 1, "unchanged": 1 }  or  200 { "ok": false, "error": "days[0].weight.unit: unknown unit 'stone'" }
```

- **Idempotent.** Each value becomes `Reading { value, asOf }` on doc `h:<date>`. Per metric, the later `asOf` wins. A resent payload, an overlapping run, or an old payload arriving late leaves the same doc. An unchanged merge bumps no rev, so hourly resends cause no phone sync churn.
- **Why today and yesterday.** The last run of the evening misses late burn. The next day's first run sends yesterday's final total with a later `asOf`, which replaces it.
- **No double count.** Health burn and manual workouts land in different kinds. The budget takes `max(active_kcal, sum of manual workouts)`, never the sum (see below).
- **Shortcut build.** Learned from stash's Shortcut. Build the body with the JSON request-body editor (Dictionary and Array fields), never a Text block, which is what let stray newlines into stash's JSON. Coerce values at the server (`z.coerce.number()`), because Shortcuts dictionaries sometimes send numbers as text. Test `ok` is true and show the raw response otherwise, never infer success from a missing error. Actions:

```
Find Health Samples  Active Energy, Start Date is today      -> Calculate Statistics Sum  -> todayKcal
Find Health Samples  Active Energy, Start Date is yesterday  -> Calculate Statistics Sum  -> yesterdayKcal
Find Health Samples  Steps, today / yesterday                -> Sum                       (optional)
Format Date  Current Date as ISO 8601                        -> asOf
Format Date  today and yesterday as yyyy-MM-dd
Get Contents of URL  POST, Request Body JSON  {v, as_of, days: [ {date, active_energy:{value, unit:"kcal"}, steps}, {...} ]}
Get Dictionary Value  ok  (Type set explicitly)
If ok is not true -> Show Notification  Contents of URL
```

Personal Automation, Time of Day, Run Immediately, at 12:00, 18:00, 21:00 and 23:50.

### Budget math

All pure, in `domain/goals.ts` and `domain/burn.ts`, called once per day view by `summarizeDay`.

```
goal      = goalOn(goals, date)                       // effective-dated, so past days keep their goal
kg        = trend weight on date                      // falls back to the latest weigh-in
baseline  = tdee(bmr(profile, kg, age), goal.burn.kind === 'eat-back' ? 'sedentary' : profile.activity)
base      = fixed ? goal.kcal : baseline + kgPerWeek * 7700 / 7
burn      = max(health.active_kcal, sum(exercise.kcal))     // never the sum
target    = base + (eat-back ? fraction * burn : 0)
remaining = target - eaten.kcal
```

Burn counts once in both policies. With `ignore`, the activity multiplier stands in for activity. With `eat-back`, the baseline drops to sedentary and measured burn replaces the multiplier. Exercise kcal is computed at log time (MET x kg x hours) and stored, so later weight changes do not rewrite past burn.

### Module map

```
2026-10-28-fuel/
  src/domain/            pure; compiled with no DOM and no Node types, so IO cannot creep in
    ids.ts               branded ids, LocalDate, Millis, Gtin
    units.ts             Kg, Kcal, conversions
    nutrients.ts         NUTRIENTS, Nutrients, Totals, scale, total
    food.ts              Food, Serving, Quantity, FoodSnapshot, Recipe, SavedMeal, Draft, nutrientsFor
    diary.ts             Entry, Meal, recents, cloneEntries
    goals.ts             Profile, Goal, bmr, tdee, budgetFor, summarizeDay
    body.ts              WeighIn, dailyWeights, trend, weeklyRate, adaptiveTdee
    burn.ts              MET table, Exercise, HealthDay, mergeHealthDay, dayBurn
    habits.ts            WaterLog, Fast, fastStatus
    kinds.ts             KINDS registry, DocOf, ClientKind, parseDoc, dexieStores
  src/protocol.ts        zod schemas for every HTTP body
  src/server/            Node types, no DOM
    main.ts              Config parse, wiring, listen, backup timer
    routes.ts            Hono app: the whole HTTP surface and static files
    store.ts             DocStore: the only SQL; sync, server-owned writes, cache, backup
    foods.ts             lookup policy: which source, caching, merging
    off.ts, usda.ts      adapters: fetch plus pure parse into FoodCandidate
    ai.ts                Anthropic adapter; pure toDrafts and labelToCandidate
    health.ts            Shortcut payload parse and ingest
  src/client/            DOM types, no Node
    main.tsx             openReplica, startSync, mount, register the service worker
    replica.ts           the only Dexie import: tables from KINDS, commit, live, SyncPort
    sync.ts              when to sync, backoff, single flight
    intents.ts           every write action
    views.ts             read models and useLive
    api.ts               the online-only calls
    scanner.ts           camera and barcode decoding
    screens/             Diary, Search, Scan, Food, Recipe, Weight, Habits, Settings
  test/                  domain units, adapter fixtures, routes via app.request, sync.sim, registry pin
  scripts/               run.sh, com.dylansavage.fuel.plist, restore.sh
```

Feature traces stay at three files or fewer per side. Logging a recent food goes `screens/Diary.tsx` to `intents.ts` to `replica.ts`, with the math in `domain/diary.ts`. The server side of the same write is `routes.ts` to `store.ts`. An unknown barcode goes `routes.ts` to `foods.ts` to `off.ts`.

### Interface depth

The screens' whole world is `useLive` with five views, `Intents` (one call per user action), `Api` (three online calls), `scanBarcode`, and a sync status. There is one way to put food in the diary. A recent tap, a library food, a recipe, a saved meal, quick add, confirmed AI drafts and copying a meal all become `Ingredient[]` and go through `intents.logItems`. Only `logCandidate` (which also imports a food) and `copyDay` (which keeps each entry's meal) differ. Behind that sit the outbox, mutation ids, the rebase rule, epoch reseeding, the Dexie schema, rev assignment, idempotent replay, OFF and USDA quirks, unit normalization, and the structured-output call. `Intents` is wide because the product has many actions. Each method still completes its action in one call, and no screen coordinates two of them. `DocStore` has seven methods and is the only module that knows SQL. The server's public surface is six routes.

### What it deliberately does not do

- No field-level merge, CRDT, or vector clock. Whole documents and server arrival order are enough for one person.
- No timestamps in conflict resolution. Device clocks are display data only.
- No background sync while the app is closed. iOS does not offer it to PWAs.
- No app-level auth. The tailnet and the `127.0.0.1` bind are the perimeter.
- No server-side diary queries. Every read model runs on the phone. The server reads docs only for AI name matching.
- No partial replica. The phone holds every doc.

## MVP slice and phasing

Each phase adds kinds, intents, views and screens. The store, the sync protocol and the replica do not change after phase 1. That is the no-rewrite property (per foundational-thinking, scaffold first).

**Phase 0. Scaffold (day 1).** Repo with the three tsconfigs and eslint import boundaries, vitest, Hono serving a placeholder PWA with its service worker, the launchd plist, `tailscale serve`, and Add to Home Screen. Human steps are enabling HTTPS certificates in the tailnet admin console, installing Tailscale on the iPhone, and adding the app to the Home Screen. Device spike for camera permission in standalone mode and barcode decoding. Done when the Home Screen app opens in airplane mode and scans a barcode to digits on screen.

**Phase 1. MVP (days 2 to 4).** Kinds `food`, `entry`, `goal`, `profile`. `DocStore.sync`, the replica, the sync loop, and `sync.sim` green. Diary day view with meals, totals and remaining. Log from recents and the library, quick add, edit and delete with undo, create a food by hand, scan to OFF lookup to import and log, USDA search, the goal calculator (Mifflin-St Jeor, TDEE, rate, macro split), and nightly backups. Done when Dylan logs a real day on the phone, including one entry made in airplane mode that shows up in `fuel.db` after reconnecting.

**Phase 2. Reuse.** Kinds `recipe` and `savedMeal`. Recipe builder, log a saved meal in one tap, copy meal and copy day, and the food-edit re-snapshot offer. No server change.

**Phase 3. AI quick log.** Text first, then label photo (creates a food with the scanned barcode, which also closes the "not found" gap), then plate photo. The key comes from tokenstash into `.env`.

**Phase 4. Body and burn.** Kinds `weighIn`, `exercise` and `health`. Trend chart, weekly rate, projected goal date, the Health Shortcut and ingest, MET workouts, and burn policy in the budget.

**Phase 5. Water and fasting.** Kinds `water` and `fast`, a water goal ring, and the fasting timer with history.

**Phase 6. Refinement.** Adaptive TDEE suggestion (needs weeks of logged data, so it lands last), a saved-scan inbox for unknown barcodes scanned offline, and a restore drill that exercises `restore.sh` and the epoch reseed against a real backup.

The order follows the daily loop first (per experience-first). Diary, scan and search are what replaces MyFitnessPal. Recipes and saved meals cut taps on repeated food. AI is the biggest delight and fixes missing products. Weight and burn need weeks of data before they matter. Water and fasting are independent of everything else.

## Synthesis decision

_Placeholder. Filled in by arena._

## Tradeoffs accepted

- We accept losing one side of a concurrent edit to the same document from two replicas, in exchange for a rebase rule that is one line and needs no clocks.
- We accept that food edits do not flow into recipes and saved meals on their own, in exchange for stable history and recipes that cannot form cycles in a replicated store. The re-snapshot offer covers the common case.
- We accept a generic JSON doc table with no SQL-level columns or foreign keys, in exchange for one registry that drives validation, sync and the phone's tables. Doc schemas therefore evolve additively only (new fields optional or defaulted). That looks like a missing migration story, and it is deliberate.
- We accept the full replica's storage on the phone, about 50 MB after ten years at 20 entries a day (estimate, guess), in exchange for full offline history, trend and recents.
- We accept that writes made offline sync only when the app is next opened online, in exchange for staying inside what iOS allows PWAs.
- We accept diverging from stash's Python, ruff and pytest conventions, in exchange for one language running the same schemas and math on the phone and the mini.
- We accept that a late weigh-in nudges past days' derived targets through the trend, in exchange for not snapshotting targets (a second writer of day state).
- We accept that `max(health, manual)` under-counts burn when a manual workout was not captured by Health, in exchange for never double counting. Under-counting is the safe side of a deficit.
- We accept no app-level auth, in exchange for zero credential handling. This holds only while the bind stays `127.0.0.1` behind `tailscale serve`.

## Alternatives considered

- **Event-sourced operation log with a shared reducer.** The textbook local-first shape. The server stores domain events and both sides fold them into projections. It loses because this domain is already mostly append-only (entries, drinks, weigh-ins), so events would mirror the documents one to one. In exchange it adds event upcasting forever, projection rebuilds on both sides, and a store Dylan cannot read with `sqlite3`. Interface depth is similar, but the hidden complexity is larger for no behavior gain.
- **SQLite-WASM replica with the same schema on both sides.** Same SQL on the phone and the mini, and a relational schema instead of JSON docs. It loses on iOS risk (OPFS sync handles need a worker; standalone-mode durability is less proven, my understanding), about 1 MB of wasm on cold start, and the need to write a changeset sync anyway. It exposes SQL to client code, which widens the surface screens can reach.
- **Off-the-shelf sync engine (Replicache/Zero, PowerSync, ElectricSQL, TinyBase, PouchDB).** It hides the protocol entirely. That is deeper on paper. It loses because each one either needs Postgres or a hosted service, replaces SQLite as the store of record, or imposes a data model (cell CRDTs, revision trees) that fits nested recipe snapshots poorly. Its complexity becomes a dependency Dylan maintains forever.
- **Python server, TypeScript client.** It matches the sibling repo. It loses because every doc schema and every nutrient formula would exist in two languages, which is the hand-synced-list red flag in its worst form.
- **Partial replica (last 30 days on the phone, older data fetched).** Smaller storage. It loses because the trend, adaptive TDEE and recents read long history, and partial replicas bring cache-miss states into every screen.

## Open questions and risks

Questions for Dylan:

- Does he wear an Apple Watch? That decides whether `eat-back` or `ignore` is the default burn policy, and whether `max(health, manual)` or a per-workout "not in Health" flag is the right double-count rule.
- Which eat-back fraction feels right, if any (MyFitnessPal credits 100%)?
- Will a second device (a laptop browser) ever write? If not, the only real conflict case cannot happen.
- Should after-midnight snacks count toward the previous day (`dayStartsAtHour`), and if so from what hour?
- AI model. The default is `claude-opus-5-5` at low effort. Is quick-log latency worth testing `claude-haiku-5-5` side by side?
- Should a food edit auto-update recipes and saved meals, or always ask?

Risks worth checking before or during phase 0:

- **Camera permission in standalone mode.** iOS has re-prompted for camera access in Home Screen apps in the past (my recollection, a guess). The phase 0 spike measures it on the device.
- **Replica eviction.** WebKit said Home Screen web apps are not subject to Safari's seven-day storage cap (my recollection of their 2020 post, unverified). The outbox is the only data at risk, it drains whenever the app is open online, and the app calls `navigator.storage.persist()`.
- **Shortcut details.** Whether Find Health Samples returns kcal or the user's display unit, and whether the JSON editor builds an array of dictionaries cleanly, are unverified. The server accepts unit strings and coerces numbers for this reason. `ingest_log` keeps the raw payloads for debugging.
- **Tailscale CLI.** `which tailscale` finds nothing on the mini (observed). The setup doc must use the app bundle's CLI or install it.
- **Native module ABI.** better-sqlite3 is built for one Node ABI. `run.sh` pins the nvm Node 22.22.3 path, so an nvm upgrade is a deliberate edit plus `npm rebuild`.
- **OFF text search.** Unverified, so the MVP's external search is USDA only, and OFF covers barcodes.
- **Old shells after a deploy.** A phone running an old cached shell can push a doc that fails a newer schema. The rule is that schema changes are additive with defaults, and a `bad_response` or rejection triggers the service worker's update prompt.

## Next implementation step

Write `domain/kinds.ts` with the `food` and `entry` kinds, `server/store.ts`'s `sync` over a `:memory:` database, and `client/replica.ts` over fake-indexeddb, then make `test/sync.sim.ts` pass before any screen exists.
