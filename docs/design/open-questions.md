# Open questions

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-10-28.

## For Dylan

1. **Eating back workouts.** The default budget policy is `activity-level`, where logged workouts do not raise the target. If you switch to `eat-back-workouts`, what fraction should count? MyFitnessPal credits 100%. Many people use 50%.
2. **Calorie floor.** Should the target never go below BMR, or only warn?
3. **Units.** Pounds for body weight is assumed. Food amounts in grams, ounces, or both?
4. **Late-night snacks.** Should food logged after midnight count toward the previous day, and until what hour?
5. **AI model.** Quick log needs to feel fast. Compare a Haiku-class and a Sonnet-class Claude model on latency and accuracy during phase 4.
6. **Food edits.** When you edit a food, should recipes and saved meals that use it update automatically, or always ask?
7. **Second device.** Will a laptop browser ever write? If not, the only real sync conflict cannot happen.
8. **MyFitnessPal history.** Do you want your MFP history imported so the trend and adaptive TDEE start with data?

## Decided

- **Wearable burn import is deferred** (2026-10-28). Dylan wears an Apple Watch but does not trust its calorie numbers. Revisit when he has a better wearable. The shape for it is in design.md under "Deferred: wearable burn import".

## Assumptions to verify on the device (phase 1)

- Camera access in a Home Screen web app works without repeated permission prompts. If not, the photo fallback becomes the default.
- iOS does not evict IndexedDB for Home Screen web apps. The app also calls `navigator.storage.persist()`.
- `tailscale serve` adds an identity header that the server could check to refuse anyone but Dylan's login.

## Human steps

- Enable HTTPS certificates in the Tailscale admin console.
- Install Tailscale on the iPhone and sign in.
- Approve the tokenstash requests for `ANTHROPIC_API_KEY` (phase 4) and `USDA_API_KEY` (phase 2).
