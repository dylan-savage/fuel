# Training in fuel

Status: awaiting Dylan's approval, 2026-11-03. Replaces a program kept in Notion. This repo is public, so examples here are invented and real data stays in `.private/`.

## Problem

Dylan logs lifting between sets on an iPhone with poor signal, and a weekly Claude review rewrites his plan. Four facts shape the design. Sync is last-arrival-wins on whole documents, so a coach and a phone must not share one. A new kind stops sync on an unrefreshed shell. Script writes fail quietly inside a 200. "Latest for X" today means scanning a whole table, and every exercise card needs it.

## Usage

```tsx
// The Train screen. A week exists because the calendar says so.
const week = useLive((r) => weekView(r, today), [today]);
await intents.startSession(week.suggested);                         // pins today's program version

// The set card. Position and rest come from stored sets, so a reload loses nothing.
const next = nextUp(planned, logs);
const rest = restClock(planned, logs);
const lasts = useLive((r) => lastTimesView(r, liftIds, session.date), [liftIds.join(), session.date]);
const undo = await intents.logSet({ session, slot, lift }, set);    // one tap, one commit, one undo
```

```
$ node scripts/train.mjs read                 # writes snapshot.json and draft.json, private
$ node scripts/train.mjs publish draft.json --dry-run
$ node scripts/train.mjs publish draft.json   # exit 0 landed, 2 invalid, 3 frozen or stale, 4 unreachable, 5 phone behind
{"status":"published","id":"p:2030-03-11","rev":4133}
```

## Shape

The coach owns one kind. The phone owns the rest. They never hold the same document, so a pending phone write cannot beat a coach write and neither needs a merge rule.

| Kind | Writer | Id | Holds |
|---|---|---|---|
| `program` | coach tool | `p:<effectiveFrom>` | Days, blocks, slots, cues, one-week notes, standing text, lift catalog, the report, explained changes |
| `session` | phone, import | UUID | Day by value, pinned version, times, skips, checklist ticks, note |
| `performance` | phone, import | `pf:<session>:<slot>:<lift>` | One exercise in one session: sets, label and target by value, planned lift if swapped, note |
| `trainingNote` | phone | UUID | A loose line to the coach with no session under it |

```ts
Load      = { kind: 'weight'; amount; unit: 'lb' | 'kg' } | { kind: 'bodyweight' } | { kind: 'band'; label }
SetReps   = { kind: 'total'; reps } | { kind: 'sides'; left; right }
SetLog    = { load; reps; warmup?: true; note?; at? }
Target    = { sets; reps: { min; max }; perSide?; load? }
Slot      = { id; liftId; label; target; swaps?; cue?; setPrompt? }
Block     = lifts { slots; restSeconds? } | checklist { items } | cardio    // plus title?, note?, optional?, onlyWeek?
Day       = { key; label; weekday?; minutes?; blocks }
Lift      = { id: slug; name; aliases; key? }
Program   = { id; effectiveFrom; days; lifts; weeklyMinimum?; notes; standing; report?; changes; publishedAt }
```

**No week document and no rollover.** A week is `mondayOf(date)`. Its plan is `plannedDay(program, day, date)`, a pure function over the version in effect. If the coach never runs again, next week still renders with correct last-time lines and hints, one-week items gone, and "No coach check-in this week" derived from the missing version. One-week blocks and notes share one mechanism, `onlyWeek`.

**Versions freeze when their date arrives.** A session pins a version, and the publish route refuses to replace a version already in effect. This calendar rule also protects a session started offline that the mini has not heard of. A mid-week change is a new version from today or tomorrow.

**Sets live on performances, indexed by lift and date.** Each set writes a small document, so the outbox and sync stay unchanged. The last-time read is two seeks per slot on `[doc.liftId+doc.date]` and `[doc.plannedLiftId+doc.date]`. Twelve slots took 1 ms at 10,000 rows against 31 ms for a scan, in desktop WebKit with invented rows. The iPhone is unmeasured, and unit 5 gates on it. The upper bound is the closed day before, because an open bound re-ran `liveQuery` on every set.

**Everything computed is derived.** `progress.ts` holds top weight, volume, Epley, hints, sessions done, skips and swaps once, for the phone and the coach's read. Nothing derived is stored.

**Identity.** A lift is a slug of its name. A renamed slot or variation keeps its `liftId` under a new label. A swap stores the lift done plus `plannedLiftId`. Merging two lifts is one alias in the catalog and rewrites no performance. A typed name logs offline under its own slug, and the coach's read lists it as uncataloged until placed. A plan naming an unknown lift fails validation, and the catalog only grows.

**Weights stay as typed.** This departs from fuel's stored-in-kg rule for body weight, because the number on the stack is the fact and converting it lost data in Notion. `lbOf` is the only conversion and it runs on read. A bodyweight or band load returns null, never 0.

**Swaps stay light.** A swap lasts for that session. Next time, the card offers "last time here you did X". The coach reads swaps on Sunday and makes the keepers permanent. Dylan can also ask Claude any time. So the app has no plan editor and no second writer of the plan.

**Diary.** Finish writes a `workout` whose id is the session's, so finishing twice converges. Minutes run first set to finish, less cardio logged inside that span, so burn is not counted twice. Cardio blocks open the existing workout logger. Weigh-ins reuse `weighIn` and the Weight sheet.

### Screens

A fifth tab, Train. An open session comes first, including after a reload.

| Event | Result |
|---|---|
| Log set | One commit, stored before the screen moves, with an undo toast |
| Superset order | `stepsOf` walks A1, A2, rest, A1, A2, rest. Warm-ups do not count as rounds. A slot with fewer sets drops out of the last round |
| Prefill | Load from the previous set of this lift today, else last time at this position. After a swap, the swapped lift's own history, never the old lift's weight |
| Tab switch or reload | Same card. Only typed digits wait in localStorage |
| Locked phone | The rest timer reads right on return because it is clock arithmetic. iOS gives no alert while locked (guess until tried on the phone) |
| Never tapped Finish | After 6 hours the session finishes at its last set's time |

### Charts

Inline SVG reusing `WeightChart`'s classes and scrub readout, one series and one axis each.

| Question | Chart |
|---|---|
| Am I showing up? | Twelve weeks of sessions against the weekly minimum |
| What is moving, what is stuck? | Key lifts: small line, latest, change, "best 5 sessions ago" |
| Am I getting stronger at this lift? | Est. 1RM line over top-weight dots, best point ringed, swaps as ticks |
| How close am I to adding weight? | Rep ladder: last 8 sessions, range as a band, a dot per set, "+5 lb" when weight rose |

Warm-ups pass through `workingSets`, and top weight and est. 1RM are maxima, so an unflagged light set cannot move them. Swapped sessions leave a gap and a tick on the planned lift, not a dip. Left out: total tonnage, which moves with which lifts he did, and a muscle-group chart, which needs every lift tagged and answers a question the coach already handles.

### Coach

A T3 scheduled task on the mini, Sundays at 07:00 with a fresh thread per run, runs the prompt checked in at `scripts/coach-prompt.md`. Each Sunday leaves a thread Dylan can read and answer. `claude -p` under launchd hung during startup in all five configurations tried on 2026-11-03, with one thread blocked in `openat` before any network call. It runs fine from a normal shell. macOS privacy protection over a config path on the Desktop is the likely cause (guess). The fallback is launchd with its own config directory and a long-lived token. A repeat run is harmless, and a missed run leaves the week in place.

- **The read.** `GET /api/train/snapshot` gives the version in effect, the last six weeks of sessions by the phone's own math, skips, swaps, every note, weigh-ins, uncataloged names, and when the phone last synced. Sessions that arrived after the last report are flagged, so a late offline session reaches the next review and the report says if the phone looks behind.
- **The write.** Claude edits a draft file in place. `POST /api/train/publish` validates it on the deployed schema, reports every problem at once and answers with a named status. Identical content answers `unchanged`, ignoring the publish stamp. The write has no field for a session or performance, so history is out of reach.
- **Silent drops are refused.** `programDiff` compares the draft with the version before it. A removed day, block, slot or cue, or a changed prescription, must be named in `changes` with a reason, or publish exits 2. The phone runs the same function and shows "What changed" under the report, so a mistake is visible outside the model that made it.

### Import

One Claude session with the Notion tools writes `.private/training/import/notion-history.json` from two independent reads: day pages set by set, and Progress verbatim. `reconcile` recomputes every Progress total through the phone's own math and refuses to write while a mismatch stands without a stated waiver. Ids derive from date and day, so it re-runs, and a row Dylan has since edited is listed as a conflict and left alone. It writes no workouts. Weigh-ins older than fuel's first are skipped by default because they move past targets, and the dry run prints the largest shift. The route and the import code are deleted at cutover.

### What ships first

The phone reports its build on every sync. The first deploy makes the shell skip and flag what it cannot read, and re-pull under a new build. Publish and import refuse until the phone reports that build, which replaces a human remembering to tap the banner.

## Synthesis decision

Two designs competed, and an independent judge traced eight failure scenarios through both, scoring them 25 to 22. The base is the living program (candidate 2), which removes the two-writer week and needs no change to core sync or to `store.sync`.

Taken from weekly plan documents (candidate 1): the phone reporting its build, scoped coach tools, warm-ups not counting as rounds, and one coach-written document per week.

Changed from candidate 2 during synthesis, removing two kinds and one fold:

- **`planEdit` removed.** It needed read-time folding and an `absorbs` list, and the judge found a way to revive old edits. Dylan's light edits happen inside a session, and the coach makes swaps permanent, which is what the Notion coach already does.
- **`coachNote` and `lift` folded into `program`.** This drops a second effective-dating scheme and leaves one expiry mechanism. The cost is that a cue rewrite now mints a version, and that omitting a cue could lose it, which the explained-changes check covers.

New in synthesis, from the judge's two shared flaws: explained changes shown on the phone, and the staleness flag on late sessions.

Rejected: a store-level rule for weeks, one outbox row per document, and a session document holding all sets, each of which forced a change to core sync or the store.

## Tradeoffs accepted

- We accept a 25 to 30 KB document per coach run in exchange for one read and one owner.
- We accept a second write path beside `/api/sync`, in exchange for validation on the deployed schema and failures that speak. It has sync's same lack of auth. `design.md`'s HTTP table changes with it.
- We accept a swap not lasting past its session until the coach or Dylan makes it permanent, in exchange for no plan editor and no fold.
- We accept a missed Sunday leaving last week's cues in place, in exchange for a week that always appears.
- We accept T3 having to be running on the mini on Sunday morning, in exchange for no launchd workaround and a thread per run.
- We accept the prompt, not the harness, limiting the coach to `scripts/train.mjs` and its private directory, because a T3 task inherits its thread's permissions.
- We accept that a one-week prescription change does not revert by itself. Claude publishes the following version too, and the prompt says so.
- We accept that a backup restore re-pushes coach documents as the phone's. A re-run of the coach fixes a reverted future version.

## Alternatives considered

- **Week documents with a rollover.** Simple to picture, but a failed job makes the phone a second writer of one document, which forced a store rule.
- **A session document holding all sets.** About 7 KB rewritten per set, which forced changes to the outbox.
- **The tool as a script speaking `/api/sync`.** No new routes, but it inherits quiet failure and validation against files a deploy deletes.

## Work order

Each unit ends in its check. Units 1 to 7 must run in order. Units 8 to 11 touch separate screens and can run in parallel. Shared writes are `kinds.ts`, `app.tsx` and `styles.css`, which units 5 and 8 settle first.

1. **Tolerant shell and phone build on sync.** Playwright serves a pull holding an unknown kind and sync stays green. Deploy, then the phone reports the build.
2. **Guards.** Adding a dummy kind fails `tsc` until the simulation covers it. A nested `z.object` fails a depth test.
3. **Pure domain.** Unit tests on invented data, including kg, bodyweight, swap and warm-up cases. Nothing registered.
4. **Reconcile real history locally.** Every Progress row matches or is waived with a reason. This tests the set model against real data before storage exists.
5. **Register the kinds, empty.** The phone's data survives the upgrade, and 10,000 invented rows open a day under 50 ms on the iPhone.
6. **Routes and tool.** Route tests for invalid, twice, frozen, stale, unexplained drop and lost response, plus a coach step in the simulation.
7. **Import for real and first program.** Totals equal Progress, a re-run writes nothing, and diary days are byte-identical.
8. **Read-only Train tab.** A fake clock crosses two Mondays with no writes: the week appears, a retest goes and a note lapses, offline.
9. **Charts.** Tests for the four corruption cases, screenshots in light and dark, on real imported data.
10. **Logging.** Playwright offline survives a reload, a tab switch and a page kill mid-set. Then one real session alongside Notion.
11. **Finish and diary.** Under both budget policies, lifting and cardio minutes do not overlap, and finishing twice leaves one workout.
12. **The schedule.** By running the T3 task now: a run, a second run that stops, a run with the server down, and a run during an open session that leaves its version byte-identical.
13. **Cutover Monday.** Final import, Notion read-only, import code deleted.

## Next implementation step

Unit 1, the tolerant shell, because nothing else can ship safely before it.
