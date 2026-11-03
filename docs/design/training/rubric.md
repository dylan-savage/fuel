# Rubric for the training design

The picker and the cross-judge score each candidate on these. Candidates do not see this file.

1. **Gym flow.** Logging a set takes one or two thumb taps with sensible prefills, offline, between sets. Supersets and rest are guided. Every real logging shape fits without a special case per exercise: differing weights per set, warm-ups, kg or lb per set, left and right reps, reps only, bodyweight, band labels, a yes/no or free-text column, checklist blocks, cardio, an on-the-spot swap, a skip, an extra set, notes anywhere.
2. **One source of truth.** Progress, last-time numbers, add-weight hints and sessions done are derived, never filled in. History stays right after a plan change, a swap or a rename. The last-time read for an exercise is traced through the structure and is cheap on the phone.
3. **Coach safety.** Claude on the mini gets everything it needs in one read and can publish a new plan that is schema-validated before it lands. Running twice does no harm. A failed or absent run still leaves a usable week. A plan change can never rewrite logged history or clobber a session in progress. The server keeps storing documents without domain rules.
4. **Fit with fuel.** Uses the `KINDS` registry, whole-document mutations, loose schemas, snapshots by value and deterministic ids. No server merge logic. Reuses `weighIn` and `workout` rather than parallel copies. Works with the existing sync, test and deploy layers.
5. **Interface depth and size.** Small public surface hiding real behavior. Few new kinds and modules. Passes `architect/references/design-red-flags.md`. The flow from a tap to a stored set traces through three files or fewer.
6. **Import and privacy.** Six weeks of Notion history load into the same model through a re-runnable path, checked against known totals. The repo is public, so real data never enters git, including fixtures.
