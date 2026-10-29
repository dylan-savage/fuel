# fuel, candidate 1: server-authoritative

## Problem

Dylan wants a MyFitnessPal replacement for one user, installed as a PWA on his iPhone. Its only durable store is SQLite on the always-on Mac mini, reached over Tailscale at `https://dylans-mac-mini.tail82aa2c.ts.net`. It covers the full MFP core (diary, barcode, search, goals, recipes, saved meals) plus four extras: weight trend, AI quick log, water and fasting, and Apple Health burn import. Three writers touch state: the PWA, an iOS Shortcut that resends Health totals several times a day, and whatever the phone does while it cannot reach the mini. Five things make the shape non-obvious. External nutrition data is per 100 g, per 100 ml or per serving, and often incomplete. Food edits must not silently rewrite past days. Health burn and manually logged exercise overlap. The Anthropic key must never leave the mini. And "the phone cannot reach the mini" is a normal state that needs an explicit answer. This candidate answers every one of these on the mini. The phone renders HTML the mini produced, and it never computes a number.

## Usage (caller's view)

### README the maintainer reads

```bash
# On the mini, in ~/Desktop/Personal-AI/2026-10-28-fuel
uv sync --extra dev
cp .env.example .env              # FUEL_DB, FUEL_TZ, USDA_API_KEY; ANTHROPIC_API_KEY via tokenstash
uv run python -m fuel serve       # 127.0.0.1:8484, applies migrations on start
tailscale serve --bg 8484         # HTTPS on the tailnet name (verify flag syntax on the installed version)
cp scripts/com.dylansavage.fuel.plist scripts/com.dylansavage.fuel-backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dylansavage.fuel.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dylansavage.fuel-backup.plist
uv run pytest -q && uv run ruff check && uv run pyright && uv run lint-imports
```

`com.dylansavage.fuel` is a `KeepAlive` agent (unlike stash's nightly job). `com.dylansavage.fuel-backup` runs `python -m fuel backup` at 03:30. That does a `VACUUM INTO` to an iCloud Drive folder and keeps 30 days. Logs go to `~/Library/Logs/fuel.log`, as in stash.

### What Dylan does on the phone

1. Safari, open the tailnet URL, Share, Add to Home Screen.
2. **Today.** A big "remaining" number, protein, carbs and fat bars, then breakfast, lunch, dinner and snacks. Each meal shows one-tap chips for its recents and saved meals ("Fage 0% · 170 g"). Water and the fast timer are below.
3. **Add.** Typing gives local results at once: recent, then frequent, then his own foods and recipes, then saved meals. USDA and Open Food Facts results load underneath about a second later. The camera button opens the iOS camera. A barcode photo goes straight to the food page with a serving picker. A label or plate photo (P4) becomes a draft he confirms.
4. **Offline.** A banner reads "Can't reach the mini. Showing 2:14 pm." Chips, saved meals, quick add, water, fast start and stop, weigh-ins and (P4) "describe what you ate" still work. Each tap is listed under "Waiting for the mini" by its label, and the totals stay as they were. Search and camera are greyed out with the reason. The next time the app opens with the mini reachable, the queue drains and the page refreshes.

### Call sites

The route handler, which is all the HTTP layer does for writes:

```python
@router.post("/commands")
async def post_command(request: Request, fuel: FuelDep) -> Response:
    env = await parse_envelope(request, fuel)          # form or JSON -> Envelope, 422 otherwise
    receipt = fuel.apply(env)                          # exactly once per env.id
    return respond(request, receipt, return_to=request.query_params.get("return_to"))
```

A behavior test showing the offline guarantee. A tap queued at 23:58 replays the next morning, still lands on its own day, and applies once:

```python
def test_queued_tap_replays_once_on_its_own_day(fuel: Fuel, yogurt: Food) -> None:
    env = envelope(
        LogFood(kind="log_food", food_id=yogurt.id, quantity=Quantity(serving_id=None, count=170), meal="snacks"),
        at="2026-10-28T23:58:00-04:00",
    )
    first = fuel.apply(env)
    again = fuel.apply(env)                            # the service worker retried
    assert again.duplicate and again.outcome == first.outcome
    snacks = fuel.day(date(2026, 10, 28)).entries["snacks"]
    assert [e.label for e in snacks] == ["Fage 0% Greek Yogurt"]
    assert fuel.day(date(2026, 10, 29)).totals.kcal == 0
```

The iOS Shortcut, hourly and at 21:00, as a Personal Automation set to run immediately:

```http
POST /ingest/health
Content-Type: application/json

{"observed_at": "2026-10-28T21:00:04-04:00",
 "days": [{"date": "2026-10-28", "active_kcal": 512.3, "steps": 9120},
          {"date": "2026-10-27", "active_kcal": 688.0, "steps": 11402}],
 "weights": [{"at": "2026-10-28T07:02:11-04:00", "value": 179.4, "unit": "lb"}]}

200 {"metrics_applied": 2, "metrics_stale": 2, "weights_applied": 0}
```

## Shape

### The line this design draws

The phone holds exactly three things:

- Cached HTML snapshots. These are read-only and labeled with their render time.
- An outbox of command bodies it could not deliver. They are opaque to the phone, and the server rendered their labels.
- Four UI behaviors in about 150 lines of vanilla JS: stamping each tap with a command id, time and zone; downscaling a camera photo; ticking the fast timer's display; listing queued labels.

The mini owns everything else. That covers every nutrient scaled or summed, every total, budget, trend point, ranking and serving resolution, every external API call, and every AI call. The "what would 1.5 servings be" preview on the food page is also a server fragment. Offline, the phone shows what it cannot know as unknown. It never estimates.

### Data structures (`sketch/fuel/model.py`)

- **One nutrient basis per food.** `basis` is `g`, `ml` or `portion`. `per_basis` holds nutrients per 100 g, per 100 ml or per 1 portion. Every quantity resolves to one `amount` in that unit. Named servings are `(label, amount)` in the same unit. Grams and millilitres never convert (no densities). This matches what Open Food Facts actually returns. Its `_100g` keys hold per-100-ml values for drinks, so `basis` comes from `serving_quantity_unit` (checked live on 2026-10-28). Per **model-the-domain**, one canonical amount deletes the "per serving or per 100 g" branch from every consumer.
- **`Nutrients` requires the core four.** `kcal`, `protein_g`, `carbs_g` and `fat_g` are required. `fiber_g`, `sugar_g` and `sodium_mg` are `None` when unknown, which is distinct from zero. A day's optional totals are `PartialSum(value, unknown)`, so the page can say "fiber 18 g (2 items unknown)". External data enters as `PartialNutrients` inside a `FoodDraft`. `nutrition.complete()` either promotes it to `NewFood` or names the missing fields, which the create form asks for. Per **type-system-discipline**, an incomplete food cannot reach the diary.
- **Entries snapshot.** An `Entry` stores its food's `per_basis`, `basis` and `amount` at log time, plus a display `ServingSnapshot`. Its nutrients are derived (`snapshot × amount / basis`), never stored. Editing or correcting a food never changes a past day. Rescaling an old entry reuses its own snapshot. `food_id` is provenance only (recents, "log again"), so quick adds and AI estimates are ordinary entries with `food_id = None`. A day's totals need no joins.
- **A recipe owns a food.** `recipe.food_id` points at a `food` row with origin `recipe`. Its `per_basis` is per portion, or per 100 g when a cooked weight is given, and it is derived from the ingredients. Search, recents, saved meals, entries and the food page all handle one loggable kind. The cost is one materialized derivation, written only in `SaveRecipe` and in `EditFood`'s cascade to recipes that use the edited food. Ingredients are plain foods, so the cascade has no cycles.
- **Commands are a closed discriminated union** (`sketch/fuel/commands.py`, 22 variants). Each travels in an `Envelope(id, at, tz, command)`. `id` is the idempotency key. `at` is when Dylan tapped, which fixes fast start times and diary days for replayed taps. A command's `day` defaults to the local date of `at`. The Today page never sends `day`, so a tap on a cached Today page after midnight lands on the new day. `Fuel.apply` matches exhaustively and ends in `assert_never`. Per **model-the-domain**, a command model replaces ad hoc mutations scattered across routes.
- **Small state machines as unions.** `FastState = NotFasting | Fasting`, also backed by a partial unique index, so two open fasts cannot exist. `DraftState = Unparsed | Ready(body) | ParseFailed | Closed`, so a draft cannot be "ready with no body". `MacroPlan = PercentSplit | GramTargets`.
- **Goals are effective-dated** (`goal.effective_from`). The target for a day comes from the goal in force that day and the trend weight that day. It is derived on read and never stored.
- **Weight is kg inside.** Pounds exist only in form parsing (`LogWeight`'s before-validator, `units.py`) and in templates.

### Who writes what

Per **separate-before-serializing-shared-state**, no two actors write the same row.

| State | Writer | Key | Repeat behavior |
|---|---|---|---|
| foods, servings, barcodes, recipes, saved meals, entries, exercise, water, fasts, goals, profile, manual weigh-ins, drafts | `Fuel.apply` (PWA commands) and `Fuel` acquisitions | command id; acquisitions by `gtin` / `(origin, external_id)` / draft status | replay returns the recorded outcome |
| `health_day`, `weigh_in` rows with source `health` | `Fuel.ingest_health` (Shortcut) | `(day, metric)`, `(day, 'health')` | latest `observed_at` wins; earliest weight sample of the day kept |
| merge of manual and Health weigh-ins | nobody (read time) | `trend.merge_sources` | manual beats Health on the same day |
| merge of Health burn and manual exercise | nobody (read time) | `energy.active_burn` | the single double-counting rule |

Per **make-operations-idempotent**, `apply` runs one `BEGIN IMMEDIATE` transaction. It checks `command_log`, runs the handler inside a savepoint, and records the outcome (applied or rejected) in the same transaction. A command id has exactly one outcome, fixed at first receipt. A crash before commit leaves nothing, so the retry applies fresh. Handlers that converge treat "already done" as applied: `DeleteEntry` on a missing entry and `EndFast` with no open fast. No network call ever happens inside a write transaction.

### The burn rule (`energy.py`)

```
target    = kcal_override or bmr * multiplier + rate_kg_per_week * 7700 / 7
baseline  = bmr * (multiplier - 1)          # activity the multiplier already assumes
burn      = Health row exists ? health_active + Σ manual where not tracked_by_health
                              : Σ all manual
budget    = target + burn_credit * max(0, burn - baseline)
remaining = budget - eaten.kcal
```

Two double counts are prevented. A watch-recorded workout is not counted again. The `tracked_by_health` flag defaults from `Profile.health_tracks_workouts`, and the day view shows ignored exercise instead of dropping it. Normal daily movement is not paid twice either, once in the activity multiplier and again as Health Active Energy. That second trap is the one MFP's naive "add exercise calories" hits.

### Module map

```
fuel/
  model.py        domain types (pure)
  nutrition.py    scale, resolve, total, recipe_basis, complete (pure)
  energy.py       BMR, target, MET, active_burn, budget (pure)
  trend.py        merge_sources, EMA series, rate, projection, adaptive TDEE (pure)
  units.py        lb/kg, oz/g, fl oz/ml at the edges (pure)
  commands.py     Command union, Envelope, Outcome, Receipt
  health.py       Shortcut ingest contract and plan() (pure)
  store.py        SQLite: migrations, Reader, Writer; rows parsed into model types
  migrations/     numbered .sql, applied by PRAGMA user_version
  service.py      Fuel: apply, ingest_health, acquisitions, read views
  sources/        off.py, usda.py, claude.py, barcode.py (domain types out, no store access)
  web/            app.py (factory), routes.py, views.py (view shaping, trend SVG),
                  templates/, static/ (htmx.min.js vendored, fuel.js, fuel.css, sw.js template)
  __main__.py     serve | backup | migrate
scripts/          com.dylansavage.fuel.plist, com.dylansavage.fuel-backup.plist
docs/             mini-setup.md, health-shortcut.md
```

A write traces through three files: `routes.py`, then `service.py`, then `store.py`, with pure helpers called from the service. `pyproject.toml` encodes the boundaries as import-linter contracts. Pure modules cannot import I/O. `fuel.web` cannot import `fuel.store` or `fuel.sources`. Adapters cannot import the store. Per **boundary-discipline**, an agent taking the shortest path that compiles hits a failing lint rather than a quiet layering leak.

### SQLite schema

The authoritative file is `sketch/fuel/migrations/0001_init.sql`. It is the full target schema, which implementation splits into one migration per phase. It loaded cleanly into SQLite on this Mac. A second open fast was rejected by the index. A stale Health observation (18:00) was ignored while the 21:00 one won. In short:

| Table | Key and invariants |
|---|---|
| `command_log` | `id` PK (client UUID); `outcome` JSON returned verbatim on replay |
| `food` | `basis` in g/ml/portion; core four `NOT NULL`, optional three nullable; `UNIQUE(origin, external_id)`; `archived_at` (never deleted) |
| `serving` | `(food_id, label)` unique; `amount > 0` in the food's basis |
| `food_barcode` | `gtin` PK (UPC-A padded to 13) |
| `food_fts` | FTS5 over name and brand, kept by triggers |
| `recipe`, `recipe_item` | `recipe.food_id UNIQUE`; items reference foods only |
| `saved_meal`, `saved_meal_item` | items reference foods with serving and count |
| `entry` | `day`, `meal`, `position`; per-basis nutrient snapshot; `amount > 0`; serving triple all-or-none; `command_id` FK |
| `draft` | status CHECK; `body` present when ready |
| `profile` | singleton (`id = 1`) |
| `goal` | `effective_from` PK; percent split sums to 100 |
| `weigh_in` | `(day, source)` PK; source in manual/health |
| `health_day` | `(day, metric)` PK; upsert `WHERE excluded.observed_at > observed_at` |
| `activity` | seeded MET table |
| `exercise` | kcal snapshot; `tracked_by_health` |
| `water` | additive rows, `command_id` FK |
| `fast` | `CHECK(ended_at > started_at)`; `UNIQUE INDEX ... WHERE ended_at IS NULL` |

The CHECK lists repeat the `Literal`s in `model.py`. `tests/test_schema.py` parses the migration and fails when the two disagree, so the hand-synced list cannot drift silently.

### HTTP surface

Pages are full HTML. Fragments exist only where htmx swaps part of a page. The one JSON route for the PWA is the replay path of `/commands`.

| Method and path | Request | Response | Phase |
|---|---|---|---|
| `GET /` | | Today page; the service worker caches the latest copy | P1 |
| `GET /day/{date}` | | Day page; forms send `day` | P1 |
| `GET /add` | `?meal&day` | Search box, quick picks, camera, digits field | P1 |
| `GET /search` | `?q&meal&day` | Fragment: local hits plus a lazy external placeholder | P1 |
| `GET /search/external` | `?q&meal&day` | Fragment: USDA and OFF hits | P2 |
| `GET /food/new` | `?gtin` or `?draft` | Create form, prefilled | P1 |
| `GET /food/{id}` | `?meal&day&entry` | Food page with serving picker | P1 |
| `GET /food/{id}/preview` | `?serving_id&count` | Fragment: nutrients for that quantity | P1 |
| `POST /commands` | `Envelope` as form fields or JSON | JSON receipt for replay (200, or 409 when rejected); `#day` fragment or `HX-Redirect` for htmx; 303 for plain forms; 422 when malformed | P1 |
| `POST /barcode` | form `gtin, meal?, day?` | 303 to `/food/{id}` or `/food/new?gtin=` | P1 |
| `POST /snap` | multipart JPEG, about 300 KB, 4 MB cap; `meal?, day?` | 303 to food, create form, or `/drafts/{id}`; 422 fragment when unreadable | P1 (barcode), P4 (AI) |
| `POST /foods/import` | form `origin, external_id, meal?, day?` | 303 to food or create form | P2 |
| `GET /recipes`, `/recipes/{id}`, `/meals` | | Editors; ingredient rows are fragments | P2 |
| `GET /body` | `?days=90` | Weigh-in form, server-rendered SVG trend, rate, projection, adaptive suggestion | P3 |
| `GET /goals`, `/goals/preview` | form fields | Page; fragment with BMR, TDEE, target and macros for unsaved values | P3 |
| `GET /drafts/{id}` | | Review screen; parses a queued draft on first view | P4 |
| `POST /ingest/health` | `HealthBatch` JSON | `IngestReport` JSON; 422 with errors | P5 |
| `GET /fast` | | Timer and history | P6 |
| `GET /sw.js` | | Worker with version and asset list injected from the hashed static dir | P0 |
| `GET /manifest.webmanifest`, `/healthz` | | Manifest; `{"ok": true}` | P0 |

The `/commands` request types are the `Command` variants in `commands.py`. Forms use one flattening convention (`quantity.count`, `items.0.food_id`), undone by `routes.unflatten`. Without JS, the route fills `id`, `at` and `tz` (Profile.tz), so plain forms still work, without idempotency.

### Health Shortcut ingest contract

`sketch/fuel/health.py` is the contract.

- **Body.** `observed_at` (when the Shortcut read Health), `days[]` with `date`, `active_kcal?` and `steps?` as day totals since local midnight, and `weights[]` with `at`, `value` and `unit` (lb or kg). Limits are 14 days and 200 weights. A date may appear only once per batch.
- **Idempotency.** Per `(day, metric)`, the row with the latest `observed_at` wins, and older observations are ignored. Resends are no-ops, out-of-order delivery cannot regress a value, and a missed run heals on the next one. Per day, the earliest Health weight sample is kept as the morning weigh-in.
- **Shortcut steps.** For today and yesterday: Find Health Samples (Active Energy, then Steps) for that day, Calculate Statistics (Sum), build the dictionary, then Find Health Samples (Weight, last 2 days). Format dates as ISO 8601 and POST with Get Contents of URL. Sending yesterday on every run catches late watch syncs. Off the tailnet, the run fails and nothing is lost, because the next run resends cumulative totals. No queue is needed.
- **Units.** `active_kcal` must be kcal. Validation rejects more than 10,000 per day as a unit mistake.

### Offline behavior

| Offline, works | Offline, refused with a reason |
|---|---|
| Open the app; see the last snapshot of any visited page, with its render time | Search (local or external) |
| Quick-pick chips and saved meals on Today (ids were rendered in) | Camera snap, typed barcode, external import |
| Quick add (label plus kcal, optional macros) | Creating or editing foods, recipes, saved meals |
| Water, fast start and end, weigh-in, delete or edit a visible entry | Draft review, goals and body pages with live numbers |
| (P4) "Describe what you ate" free text, parsed by Claude on reconnect | |

Every queueable action is a `POST /commands` whose ids the cached page already holds. Offline never creates an entity that a later queued command must reference, so the phone never mints entity ids, never merges, and never resolves conflicts. A replay the server rejects ("food archived") moves to a visible "couldn't log" list with the server's reason. iOS has no Background Sync, so the outbox drains when the app is next opened (or foregrounded) with the mini reachable. Totals never move offline. The banner says how many items they exclude. This is the honest limit of server authority, and it is accepted below.

### Stack

| Choice | Picked | Over | Why |
|---|---|---|---|
| Language | Python 3.12, uv, ruff (PEP 257), pytest, pyright strict, import-linter | TypeScript | A thin client deletes TypeScript's main advantage here, which is types shared with a rich client. The work that remains is on the server: image decode (zxing-cpp, Pillow), the Anthropic SDK, SQLite, and launchd conventions copied from stash. The cost is untyped templates, covered by StrictUndefined plus a render-every-template test. |
| Web | FastAPI, sync handlers | Starlette (hand parsing), Litestar (smaller ecosystem), Django (ORM and admin overkill, a second schema) | Pydantic discriminated unions parse `Command` and `HealthBatch` at the boundary for free. Sync handlers on the threadpool are plenty for one user and keep tests simple. |
| HTML | Jinja2 plus htmx 2 (vendored, about 50 KB) with `hx-boost` | React or Preact SPA plus JSON API; htpy (typed Python HTML) | An SPA needs a JSON read API and client state, which is the drift toward a fat client this direction rejects. htpy would type-check views but is unfamiliar and reads worse for full pages. |
| DB layer | stdlib `sqlite3`, SQL in `store.py`, numbered `.sql` migrations by `user_version`, FTS5 | SQLAlchemy Core or ORM, SQLModel | About 20 tables and one user. An ORM is a second description of the schema plus a heavy dependency. Rows parse through the same pydantic models. |
| Barcode | zxing-cpp on the mini, from a photo | `barcode-detector` (zxing-wasm) live in the page; pyzbar | Verified here. The wheel installs on this Mac (Python 3.12) and decoded a rotated, blurred synthetic EAN-13. No camera permission prompt in standalone mode, no wasm in the shell cache, and no dependence on WebKit's unverified `BarcodeDetector`. One camera path also serves AI label and plate photos. pyzbar needs Homebrew zbar and is weaker on damaged codes. |
| PWA | Hand-written service worker (about 120 lines), static manifest | Workbox | Three routing rules and one outbox do not need a build step or a library. |
| HTTP clients | httpx (sync), anthropic (sync) | aiohttp, async | Matches sync handlers. External calls never hold a transaction. |
| Serving | uvicorn on 127.0.0.1:8484 behind `tailscale serve` HTTPS; launchd `KeepAlive` | Caddy or nginx | Tailscale already terminates TLS with a valid cert for the tailnet name. |

### Interface depth

The PWA's whole write surface is one URL whose body is a typed union. Its read surface is pages. `Fuel` exposes about fifteen methods: `apply`, `ingest_health`, four acquisitions and the read views. Behind them it hides SQL and migrations, command idempotency, snapshotting, recipe recomputation, the burn rule, the trend, ranking, and four external services. Callers never coordinate steps. "Log this barcode" is `resolve_barcode`, then a page, then `apply(LogFood)`, and each step is complete on its own. The widest interface is `store.Reader`/`Writer`. That width is the persistence boundary itself, and only `service.py` can reach it.

## Synthesis decision

_Placeholder. Filled in by arena._

## MVP and phasing

Each phase ends usable, with a check run on the real phone (per **foundational-thinking**, scaffold first).

- **P0, scaffold.** Repo, pyproject, lint, types, import contracts, pytest, `store.py` with migrations, `Envelope` and `Fuel.apply` with `command_log`, an empty Today page, manifest, service worker shell cache, launchd plus `tailscale serve`, nightly backup. Check: the Home Screen app opens over HTTPS, and still opens (stale) with the server stopped.
- **P1, MVP: replaces MFP for daily logging.** Manual foods with servings, diary by meal, totals and remaining against a typed target (`SetGoal` with `kcal_override` and gram macros), quick add, recents and frequents, local FTS search, snap or typed barcode with Open Food Facts import, edit, move and delete entries, copy a meal or day from yesterday, and the offline outbox. Check: one full real day logged on the phone, including two taps in airplane mode that land on reconnect with the right day and time.
- **P2, catalog depth.** Recipes, saved meals (including "save this meal" from the diary), and USDA plus OFF text search with import.
- **P3, goals and body.** Profile, Mifflin-St Jeor, TDEE, rate to target, macro split (replacing the typed target), weigh-ins, EMA trend as a server SVG, weekly rate, projected goal date.
- **P4, AI quick log.** `LogText` (queueable), snap falls through to Claude for labels and plates, the draft review screen, `ConfirmDraft`, catalog matching.
- **P5, burn.** `/ingest/health` and the Shortcut doc, the MET exercise log, the burn rule in the budget, Health weigh-ins merged into the trend.
- **P6, water and fasting.** Small and independent. They can move anywhere after P1 if Dylan wants them sooner.
- **P7, refinements.** Adaptive TDEE suggestions (needs a "day complete" marker), CSV export, and an optional MFP history import.

P3 lands before P5 because the burn rule needs `bmr` and the multiplier. P4 lands before P5 because free text is the best offline fallback and the bigger daily win.

## Tradeoffs accepted

- We accept that search, scanning and new foods do not work offline. In exchange, every rule and number has exactly one implementation, on the mini.
- We accept stale totals while offline, with queued taps listed by label and no numbers. In exchange, the phone never shows a number the mini did not compute.
- We accept a photo-snap barcode flow (shutter, "Use Photo", an upload of about 300 KB) over a live viewfinder. In exchange, there are no camera permission prompts, no wasm, and one camera pipeline for barcodes and AI.
- We accept that fixing a food's nutrients does not fix past entries. In exchange, history is stable and day math needs no joins. A later "refresh from food" action on an entry would be an explicit command.
- We accept one materialized derivation (a recipe food's `per_basis`), recomputed in exactly two places in `service.py`. In exchange, every other consumer handles one loggable kind.
- We accept that scanning a barcode imports the product into the catalog even if it is never logged. Imports are idempotent and harmless.
- We accept that daily targets move with the trend weight, and that adding a late weigh-in can shift a past day's target by a few kcal. In exchange, no stored target needs syncing.
- We accept the mini as a single point of failure. Nightly `VACUUM INTO` to iCloud Drive is the mitigation, not replication.
- We accept no app-level auth. The tailnet is the perimeter, and uvicorn binds loopback only.
- We accept untyped Jinja templates. View models plus StrictUndefined plus a render-all test catch most of it.

## Alternatives considered

- **JSON API plus a small SPA, still server-authoritative.** It exposes every read model as a wire contract and needs client routing, client state and a second set of types. It hides nothing the HTML version does not, and it buys no offline capability. It lost on interface depth.
- **REST writes per resource with an `Idempotency-Key` header.** Idempotency would be enforced per route, and the outbox would replay arbitrary requests. It lost to one exhaustive command union with one idempotency point.
- **No offline writes at all (read-only snapshot).** It is the smallest design. It lost because logging at the table with bad signal is the core loop. The outbox costs one table and about 100 lines of worker code that the idempotent command path needed anyway.
- **Live barcode decoding in the page with `barcode-detector`.** It gives a faster-feeling viewfinder and would allow queuing a scanned GTIN offline. It lost because it needs getUserMedia in a standalone PWA, ships about 1 MB of wasm in the shell cache, and splits the camera path from the AI photo path. It stays the fallback if the snap spike disappoints.
- **Live food references instead of snapshots.** History would drift on edits, and every day total would need the current food state.
- **Recipes as a separate loggable kind (`Food | Recipe` in entries, search and saved meals).** It adds a branch in every consumer to avoid one localized derivation.
- **TypeScript (Hono with TSX views, better-sqlite3 or `node:sqlite`).** It has typed templates. It lost because the code that remains is server image and AI work, Python matches the mini's existing launchd and pytest conventions, and nothing is shared with the client.

## Open questions and risks

- **Biggest risk: how often is the phone off the tailnet at mealtime?** Gym basements, flights, and iOS dropping the VPN all count. If it is often, the refused-offline list hurts daily, and the local-first candidate's case strengthens. Should fuel.js record failed `/healthz` pings in IndexedDB and report them on reconnect, so two weeks of real data decide this instead of a guess? Tailscale "VPN On Demand" on the phone may make it rare.
- **Is photo snap fast enough?** Real-phone decode is untested, since only a synthetic image was verified. Should the first P1 task be a one-hour spike on the phone timing snap against a live viewfinder?
- **Does Dylan wear an Apple Watch?** That sets the `health_tracks_workouts` default.
- **What defaults for the activity multiplier and `burn_credit`?** Sedentary 1.2 with credit 1.0 is the honest default. Many people prefer 0.5 because device burn overshoots.
- **Should there be a calorie floor** (for example, never below BMR) or only a warning?
- **Should OFF products auto-import on scan** (as designed) or open a confirm screen first, given uneven data quality?
- **Should the app check the Tailscale identity header** that `tailscale serve` adds, to refuse anything that is not Dylan's login? Verify the header exists on the installed version.
- **Does iOS evict the service worker cache or IndexedDB for Home Screen apps after inactivity?** Verify. If it does, a queued tap could be lost after a long offline stretch.
- **Is one weigh-in per day per source enough**, or does Dylan weigh more than once a day?
- **Should P1 include an MFP history import** so the trend and adaptive TDEE start with history?
- Human steps remain. Enable HTTPS certificates in the tailnet admin console, put the iPhone on the tailnet, and get `ANTHROPIC_API_KEY` and `USDA_API_KEY` via tokenstash.

## Next implementation step

Scaffold the repo with `store.py` migrations, `Envelope`, and `Fuel.apply` handling `QuickAdd` and `DeleteEntry`. Then add a test that a replayed envelope applies once and lands on the day of its `at`, and serve the Today page to the phone through `tailscale serve`.
