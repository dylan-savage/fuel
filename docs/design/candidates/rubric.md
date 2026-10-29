# Rubric for the fuel design contest

Score each criterion 1-5 per candidate, with one or two sentences of evidence citing the candidate's files.

1. **Domain model.** Foods, servings, recipes, saved meals and diary entries are modeled so nutrient math lives in one place and past days stay stable when a food or recipe is edited. Illegal states (an entry with no quantity basis, a recipe that contains itself) are hard to represent.
2. **Daily-use experience.** Logging a recent or scanned food takes few taps and feels instant on an iPhone PWA. The behavior when the mini or Tailscale is unreachable is explicit and acceptable for a food diary used at restaurants and the gym.
3. **Interface depth and reader load.** Small public surface hiding real capability. Short call chains (a feature traces in three files or fewer). One way to do each task. No hand-synced lists between client and server.
4. **Boundaries and writers.** External data (Open Food Facts, USDA, Anthropic, Health Shortcut) is parsed into domain types at the edge. Each piece of state has one owner. Health ingest is idempotent under repeated Shortcut runs and does not double count manually logged exercise.
5. **Operability for one person.** One service on the mini under launchd, simple backups, easy to test locally and verify end to end. Low ongoing maintenance.
6. **Scope discipline.** A credible MVP slice that is usable within days, with later features landing without rewrites.
