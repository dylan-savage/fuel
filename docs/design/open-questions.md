# Open questions

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-10-28.

## For Dylan

1. **Eating back workouts.** The default budget policy is `activity-level`, where logged workouts do not raise the target. If you switch to `eat-back-workouts`, what fraction should count? MyFitnessPal credits 100%. Many people use 50%.
2. **Calorie floor.** Should the target never go below BMR, or only warn?
3. **Units.** Pounds for body weight is assumed. Food amounts in grams, ounces, or both?
4. **Late-night snacks.** Should food logged after midnight count toward the previous day, and until what hour?
5. **AI model.** Quick log needs to feel fast. Compare a Haiku-class and a Sonnet-class Claude model on latency and accuracy during phase 4.
6. **Second device.** Will a laptop browser ever write? If not, the only real sync conflict cannot happen.
7. **MyFitnessPal history.** Do you want your MFP history imported so the trend and adaptive TDEE start with data?
8. **Recents order.** Recents rank by how often you log a food, with each use counting half as much after a week, so daily staples stay on top. The other option is plain most-recent-first. Which feels right after a week of use?
9. **Water units.** Water shows fl oz (stored in ml), to match pounds, with +8 and +16 oz on Today and 8, 12, 16 and 24 oz plus any amount in the water sheet. Would you rather see ml, or other quick amounts such as a 16.9 oz bottle?
10. **Fasting streak day.** A fast counts toward the streak on the day it ends, if it reached its target. Should it count on the day it started instead?
11. **Backdated fasts.** A fast starts when you tap Start. Do you want to set an earlier start ("I stopped eating at 8 pm") or edit a past fast?
12. **Editing saved meals.** A saved meal can be logged or deleted, not edited. To change one, delete it and save a diary meal again. Is that enough?

## Decided

- **Food and recipe edits ask first** (2026-10-28). After you edit a food or recipe that recipes or saved meals use, the app asks "also update 2 recipes and 1 saved meal?" and changes them only on yes, with an undo. Diary entries never change. Say if you would rather they update without asking.
- **Wearable burn import is deferred** (2026-10-28). Dylan wears an Apple Watch but does not trust its calorie numbers. Revisit when he has a better wearable. The shape for it is in design.md under "Deferred: wearable burn import".

## Assumptions to verify on the device (phase 1)

- Camera access in a Home Screen web app works without repeated permission prompts. If not, the photo fallback becomes the default.
- iOS does not evict IndexedDB for Home Screen web apps. The app also calls `navigator.storage.persist()`.
- `tailscale serve` adds an identity header that the server could check to refuse anyone but Dylan's login.

## Assumptions to verify on the device (phase 2)

- The status bar uses `default` style so it stays readable in light mode. Check it in light and dark in the Home Screen app.
- Sheets with a number field stay usable with the keyboard up, and inputs do not zoom on focus.
- A typed barcode and a camera scan both reach the confirm sheet, and a known product logs in airplane mode.

## Assumptions to verify on the device (phases 3 and 6)

- The recipe builder with the ingredient picker stacked over it scrolls well with the keyboard up.
- The fast timer shows the right time after the app comes back from the background. It is derived from the start time, so only the once-a-second tick has to resume.
- "End fast" on the Today tile is not easy to hit by accident. The toast offers an undo.

## Human steps

- Enable HTTPS certificates in the Tailscale admin console.
- Install Tailscale on the iPhone and sign in.
- After deploying phases 3 and 6, open the app and tap "A new version is ready" before logging. The older cached app cannot read recipe, saved meal, water or fast documents, so its sync stops with an error until it reloads. Nothing is lost: its outbox waits.
- Approve the tokenstash requests for `ANTHROPIC_API_KEY` (phase 4) and `USDA_API_KEY` (phase 2). The USDA request is filed and pending. Once it is approved, run `node --env-file-if-exists=../.env.local scripts/record-fixtures.mjs usda`, add `test/usda.test.ts` against the recordings, and restart the server so search includes USDA.
