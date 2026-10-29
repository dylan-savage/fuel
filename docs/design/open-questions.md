# Open questions

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-10-28.

## For Dylan

1. **Apple Watch.** Do you wear one? It sets the default burn policy (`measured` with a watch, `fixed` without) and whether workouts default to `trackedByHealth`.
2. **Eating back burned calories.** Under the `measured` policy, what fraction of burn should raise the budget? MyFitnessPal credits 100%. Many people use 50% because device estimates run high.
3. **Calorie floor.** Should the target never go below BMR, or only warn?
4. **Units.** Pounds for body weight is assumed. Food amounts in grams, ounces, or both?
5. **Late-night snacks.** Should food logged after midnight count toward the previous day, and until what hour?
6. **AI model.** Quick log needs to feel fast. Compare a Haiku-class and a Sonnet-class Claude model on latency and accuracy during phase 4.
7. **Food edits.** When you edit a food, should recipes and saved meals that use it update automatically, or always ask?
8. **Second device.** Will a laptop browser ever write? If not, the only real sync conflict cannot happen.
9. **MyFitnessPal history.** Do you want your MFP history imported so the trend and adaptive TDEE start with data?

## Assumptions to verify on the device (phase 1)

- Camera access in a Home Screen web app works without repeated permission prompts. If not, the photo fallback becomes the default.
- iOS does not evict IndexedDB for Home Screen web apps. The app also calls `navigator.storage.persist()`.
- The Shortcuts "Find Health Samples" action returns kcal, and the JSON body editor builds an array of dictionaries cleanly.
- `tailscale serve` adds an identity header that the server could check to refuse anyone but Dylan's login.

## Human steps

- Enable HTTPS certificates in the Tailscale admin console.
- Install Tailscale on the iPhone and sign in.
- Approve the tokenstash requests for `ANTHROPIC_API_KEY` (phase 4) and `USDA_API_KEY` (phase 2).
