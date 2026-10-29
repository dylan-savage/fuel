# Grounding: personal calorie and macro tracker ("fuel")

## Who and what

Dylan wants a personal replacement for MyFitnessPal that he uses on his iPhone. One user, forever. No App Store, no social features, no ads, no multi-user accounts.

### Decisions Dylan already made (do not relitigate)

- **App type.** A PWA installed to the iPhone Home Screen. No native app, no Xcode (it is not installed), no Apple Developer account.
- **Data location.** The durable store is a SQLite database on Dylan's Mac mini (the machine this repo lives on, always on). The phone reaches it over Tailscale.
- **Extras wanted, all four.** Weight trend, AI quick log, water + fasting timer, Apple Health burn import via an iOS Shortcut.

### Core features

1. **Calorie + macro logging.** A daily diary split into meals (breakfast, lunch, dinner, snacks). Each entry is a food with a quantity in servings or grams/ml. Totals for kcal, protein, carbs, fat, plus fiber, sugar and sodium where known. Remaining-vs-goal for the day.
2. **Barcode scanning.** Phone camera scans EAN-13/UPC-A, looks up the product, logs it. Products not found can be created manually (or via AI from a label photo).
3. **Food search.** Recent and frequent foods first, then the user's own foods, recipes and meals, then external databases.
4. **Goal + burn calculators.** BMR (Mifflin-St Jeor), TDEE via activity multiplier, goal rate (for example lose 1 lb/week) turned into a daily calorie target, macro targets (grams or % split). Exercise burn from MET × body weight × duration for manually logged workouts.
5. **Recipes and saved meals.** A recipe is ingredients (food + quantity) yielding N servings, so a serving has derived nutrients. A saved meal is a bundle of entries ("usual breakfast") logged in one tap. Copy a meal or a whole day from yesterday.

### Extras

6. **Weight trend.** Weigh-ins, a smoothed trend line (exponential moving average, Hacker's Diet style: trend += 0.1 × (weight − trend)), weekly rate, projected goal date. Optionally an adaptive TDEE estimate from intake vs trend change (MacroFactor-style), used to suggest a corrected calorie target.
7. **AI quick log.** Free text ("2 eggs and toast with butter") or a photo (nutrition label, plate of food) becomes draft entries the user confirms before saving. Uses the Anthropic API. The key must stay on the server, never on the phone. Key is obtained via tokenstash into the repo's env file.
8. **Water + fasting.** Water intake per day with a goal. An intermittent-fasting timer (start/stop, target window, history).
9. **Apple Health burn import.** An iOS Shortcut Personal Automation (for example hourly or at 9 pm) reads Health samples (Active Energy, optionally weight and steps) and POSTs JSON to the mini. The Shortcut can run several times a day and resend the same data, so ingest must be idempotent (upsert per day and metric, never append duplicates). The calorie budget for the day should account for burn without double counting manually logged exercise.

## Environment and constraints

- **Host.** Mac mini, macOS, always on. Node 22 and uv (Python) are installed. Long-running services on this mini run as launchd agents, as in the sibling project `~/Desktop/Personal-AI/2026-09-13-stash` (`scripts/com.dylansavage.stash.plist`, Python, pytest, ruff).
- **Network.** Tailnet suffix `tail82aa2c.ts.net`. The mini is `dylans-mac-mini.tail82aa2c.ts.net`. `tailscale serve` can terminate HTTPS with a valid certificate for that name, but HTTPS certificates are not yet enabled in the tailnet admin console and the iPhone is not yet on the tailnet. Both are one-time human steps.
- **Secure context.** Camera access (getUserMedia) and service workers need HTTPS, so the app must be served over `https://dylans-mac-mini.tail82aa2c.ts.net`. The tailnet is the perimeter. Nothing is exposed to the public internet.
- **Reachability.** When the phone is off the tailnet or the mini is down, the app should still open (service worker caches the shell). What happens to logging in that state is a design decision you must make explicitly.
- **Repo conventions.** Lives at `~/Desktop/Personal-AI/2026-10-28-fuel/`, its own git repo, solo, conventional signed commits. TypeScript strict with JSDoc on public APIs, or Python with ruff and PEP 257. Pick one and justify it.

## External data sources (facts as known, verify before relying on details)

- **Open Food Facts.** Free, no key. Barcode lookup `GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json`. Nutrients in `product.nutriments` keyed like `energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`, `fat_100g`, `fiber_100g`, `sugars_100g`, `sodium_100g`, plus `_serving` variants, and `serving_size` / `serving_quantity`. Data quality varies; fields are often missing. They ask for a descriptive User-Agent.
- **USDA FoodData Central.** Free API key (DEMO_KEY works at low rate limits). Good for generic foods ("banana", "chicken breast") with portion data.
- **Anthropic API.** Vision-capable Claude models for label and plate photos, structured output for free text parsing.
- **Barcode decoding in iOS Safari.** Native `BarcodeDetector` support in WebKit is unverified. The `barcode-detector` npm package is a polyfill over zxing-wasm that uses the native API when present.

## Domain notes worth deciding explicitly

- Nutrient basis. External foods report per 100 g and/or per serving. Pick one canonical basis and a serving model (named servings with gram weights).
- History stability. If a food or recipe is edited later, do past diary days change? MyFitnessPal effectively snapshots. Decide and encode it.
- Writers. The PWA, the Health Shortcut and (if chosen) an offline queue all write. Say who owns each piece of state.
- Units. Dylan is likely imperial for body weight (lb); store canonical metric and convert at the edge, or decide otherwise.

## Out of scope

Social feeds, friends, multi-user, App Store distribution, meal-plan marketplaces, ads, premium tiers, Android.
