# Training in fuel

Status: approved by Dylan, 2026-11-03. Replaces a program kept in Notion. On 2026-11-04 he dropped the guided live workout for a plain log, and the Session and Screens sections below describe that. This repo is public, so examples here are invented and real data stays in `.private/`.

## Problem

Dylan logs lifting between sets on an iPhone with poor signal, and a weekly Claude review rewrites his plan. Four facts shape the design. Sync is last-arrival-wins on whole documents, so a coach and a phone must not share one. A new kind stops sync on an unrefreshed shell. Script writes fail quietly inside a 200. "Latest for X" today means scanning a whole table, and every exercise card needs it.

## Usage

```tsx
// The Train screen. A week exists because the calendar says so.
const week = useLive((r) => weekView(r, today), [today]);

// A day and its exercises. What they show comes from stored sets, so a reload loses nothing.
const view = useLive((r) => dayScreenView(r, day), [day.key, day.date]);
const log = slotLog(slot, view);                                    // "Set 2 of 3" is log.done + 1, for this exercise alone
const rows = useLive((r) => lastTimesView(r, liftIds, day.date), [liftIds.join(), day.date]);
const undo = await intents.logSet({ day, slot, lift }, entry);      // one tap, one commit, one undo, and the day's session if this is its first write
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
Note      = { title?; text; onlyWeek?; day? }                       // with day, on that day's screen and not the week's
```

**No week document and no rollover.** A week is `mondayOf(date)`. Its plan is `plannedDay(program, day, date)`, a pure function over the version in effect. If the coach never runs again, next week still renders with correct last-time lines and hints, one-week items gone, and "No coach check-in this week" derived from the missing version. One-week blocks and notes share one mechanism, `onlyWeek`.

**Versions freeze when their date arrives.** A session pins a version, and the publish route refuses to replace a version already in effect. This calendar rule also protects a session made offline that the mini has not heard of. A mid-week change is a new version from today or tomorrow.

**Sets live on performances, indexed by lift and date.** Each set writes a small document, so the outbox and sync stay unchanged. The last-time read is two seeks per slot on `[doc.liftId+doc.date]` and `[doc.plannedLiftId+doc.date]`. On Dylan's iPhone with 10,000 invented performances, on 2026-11-03: opening a day took 5 ms (range 4 to 8), storing a set 2 ms (range 1 to 3), twelve last-time reads 3 ms against 43 ms for a scan, and a five-year lift chart 4 ms. Medians of 25 runs, in Firefox for iOS, which uses the same WebKit engine as the Home Screen app. They time storage, not drawing the screen. The upper bound is the closed day before, because an open bound re-ran `liveQuery` on every set.

**Everything computed is derived.** `progress.ts` holds top weight, volume, Epley, hints, sessions done, skips and swaps once, for the phone and the coach's read. Nothing derived is stored.

**Identity.** A lift is a slug of its name. A renamed slot or variation keeps its `liftId` under a new label. A swap stores the lift done plus `plannedLiftId`. Merging two lifts is one alias in the catalog and rewrites no performance. A typed name logs offline under its own slug, and the coach's read lists it as uncataloged until placed. A plan naming an unknown lift fails validation, and the catalog only grows.

**Weights stay as typed.** This departs from fuel's stored-in-kg rule for body weight, because the number on the stack is the fact and converting it lost data in Notion. `lbOf` is the only conversion and it runs on read. A bodyweight or band load returns null, never 0.

**Swaps stay light.** A swap lasts for that day. Next time, the exercise offers "last time here you did X". The coach reads swaps on Sunday and makes the keepers permanent. Dylan can also ask Claude any time. So the app has no plan editor and no second writer of the plan.

**Diary.** Settling writes a `workout` whose id is the session's, so settling twice converges. Minutes run first set to last, less cardio logged inside that span, so burn is not counted twice. Cardio blocks open the existing workout logger and make no session. Weigh-ins reuse `weighIn` and the Weight sheet.

### Screens

The Train tab shows the week: its count and strip, the days as equal rows, and rows for Coach, Progress, Program and Weigh in. Each day opens its own screen, and each exercise on it opens its own. `Train` holds where he is above the tab, so a tab switch loses nothing. A reload starts on the Diary as other tabs do, unless a set in the last three hours starts it on the week. `weekView` and `dayScreenView` re-run on a logged set. `lastTimesView` does not, because its reads stop at the day before.

The Coach sheet holds everything the coach says, and comes from which versions took effect this week. With none it reads "No check-in this week". A draft starts with no report, so a mid-week version keeps the report Monday's brought, and "What changed" lists every version of the week against the one before it. A version effective Monday is not in effect on the Sunday it is published, so its report shows from Monday.

A tap on Train paints the day list by 48 ms (range 47 to 48, 25 runs after a tab switch) and by 47 ms (46 to 48, 5 runs after a reload), with 810 sessions, 6,647 performances and a 25.6 KB version on the phone. With only the versions on the phone it is 49 ms (46 to 49), so history does not bound it. The list reaches the DOM at 22 ms, and the rest is the two frames the check waits for, which is inferred from that split and not profiled. Measured on 2026-11-04 in desktop WebKit under Playwright against a production build. It has not been measured on the iPhone.

A day's rows are its exercises, its checklists and its cardio, in the plan's order with optional blocks folded at the end. Nothing is highlighted, numbered or suggested, because machine availability decides the order. A superset keeps its label as plain information. The day stays mounted under an open exercise, so what he expanded is still expanded on Back, and Back restores his scroll.

| Event | Result |
|---|---|
| Log set | One commit, stored before the screen moves, with an undo toast. It stays on the exercise and fills in the next set |
| Any order | Any exercise opens at any time. "Set 2 of 3" counts that exercise's working sets alone, across a swap. Warm-ups do not count. Past the prescription it reads "Extra set" and keeps logging |
| Prefill | Load from the previous set of this lift today, else last time at this position. After a swap, the swapped lift's own history, never the old lift's weight |
| Tab switch | The same screen |
| Reload or killed page | The week or the Diary. Each exercise's typed digits and a swap with no set wait in one localStorage value for that day and date |
| Skip | Back to the day, with the row marked and an undo. A later set on it takes the skip back |
| Undo of a day's first write | Takes the session with it |
| Delete of the only set | The day is not done. The session goes at the next settle |

### The session

A session is a record, not a mode. Nothing on screen names one, and nothing starts or finishes it.

- **Made by the first write.** The first set, skip, note or checklist tick for a day on a date makes it through one helper in `intents`, in that write's own commit, pinned to the version in effect. Opening a screen, typing and choosing a swap write nothing. Cardio writes a workout and no session.
- **One per day per date.** Later writes that date for that day reuse it, and another date makes a new one, including a set just past midnight. An import is never written to.
- **Done means a set.** A day is done when it has a working set, as `weekProgress` already derives. So a tick, skip or note alone does not count, and removing the only set takes the mark off.
- **It settles by itself.** `settleLapsed` runs at launch and on each return to the app, and says nothing. Six hours after its last set it writes `finishedAt` at that set's time and the workout. With no timed set left, it removes any workout the session once earned, and removes the session too if nothing else is in it.
- **A new set reopens it.** A set or an edit in a session settled earlier that date clears `finishedAt`, so the workout converges at the next settle. Undo restores the settled session.
- **It keeps its version.** Once a day holds a write, it reads the version it pinned, so a publish changes nothing under him until another date. Before that it follows the version in effect, and an open exercise the new plan lacks gives way to the day. A phone not holding the pin reads the version in effect.

The coach still reads `open` for a session under six hours old, and required slots with no set become skips only after that.

### The exercise

Top to bottom: Back, the exercise, today's sets as small values, then the steppers, Log set and the five quiet actions in thumb reach above the tab bar. Rest shows only as plain text under Cue, because the coach writes it and nothing counts it down. A note can sit on an exercise only once it has a set, since a performance is the proof of one, so before that it goes on the day.

The tab bar stays. Keeping it means the Diary and water stay one tap away between sets, and a tab switch is a real path that loses nothing. At 320 by 568 the tallest exercise, a long name with per-side reps, fits with the bar in place because the controls tighten below 620 points of height.

iOS does not resize the layout for its keyboard, so the screen reads the visual viewport, shrinks to fit above the keyboard and drops the action row, leaving the field and Log set. Playwright shows no keyboard, so this is checked against a keyboard reported the way iOS reports one (inferred). It has not been tried on the phone.

A tap on Log set shows the next set in the DOM by 9 ms (range 4 to 14) and paints it by 31 ms (23 to 48), over 48 taps across two days logged last exercise first, with 810 sessions, 6,647 performances and 36 versions on the phone. Every tap stayed on its exercise and showed its next set, and every set reached the server. The rest of the time is the two frames the check waits for, inferred from that split and not profiled. Measured on 2026-11-04 in desktop WebKit under Playwright against a production build. It has not been measured on the iPhone.

### Charts

Inline SVG reusing `WeightChart`'s classes and scrub readout, one series and one axis each.

| Question | Chart |
|---|---|
| Am I showing up? | Twelve weeks of sessions against the weekly minimum |
| What is moving, what is stuck? | Key lifts: small line, latest, change, "best 5 sessions ago" |
| Am I getting stronger at this lift? | Est. 1RM line over top-weight dots, best point ringed, swaps as ticks |
| How close am I to adding weight? | Not a plot. A headline such as "8 reps from adding weight", one bar per set against the top of the range with its number beside it, and recent sessions as plain rows marked where weight went up |

Warm-ups pass through `workingSets`. Top weight and est. 1RM are maxima, so an unflagged warm-up up to 60% of the load and 20 reps cannot move them, and a test pins that limit. On a per-side set, est. 1RM reads the better side and the add-weight hint reads the weaker side, so both sides earn the added weight. Swapped sessions leave a gap and a tick on the planned lift, not a dip. Left out: a dotted rep ladder, which Dylan found hard to read, total tonnage, which moves with which lifts he did, and a muscle-group chart, which needs every lift tagged and answers a question the coach already handles.

### Coach

A T3 scheduled task on the mini, Sundays at 07:00 with a fresh thread per run, runs the prompt checked in at `scripts/coach-prompt.md`. Each Sunday leaves a thread Dylan can read and answer. `claude -p` under launchd hung during startup in all five configurations tried on 2026-11-03, with one thread blocked in `openat` before any network call. It runs fine from a normal shell. macOS privacy protection over a config path on the Desktop is the likely cause (guess). The fallback is launchd with its own config directory and a long-lived token. A repeat run is harmless, and a missed run leaves the week in place.

- **The read.** `GET /api/train/snapshot` gives the version in effect, the last six weeks of sessions by the phone's own math, skips, swaps, every note, weigh-ins, weekly average calories and protein from the diary, uncataloged names, and when the phone last synced. Sessions that arrived after the last report are flagged, so a late offline session reaches the next review and the report says if the phone looks behind.
- **The write.** Claude edits a draft file in place. `POST /api/train/publish` validates it on the deployed schema, reports every problem at once and answers with a named status. Identical content answers `unchanged`, ignoring the publish stamp. The write has no field for a session or performance, so history is out of reach.
- **Silent drops are refused.** `programDiff` compares the draft with the version before it. A removed day, block, slot or cue, or a changed prescription, must be named in `changes` with a reason, or publish exits 2. The phone runs the same function and shows "What changed" under the report, so a mistake is visible outside the model that made it.

### Import

One Claude session with the Notion tools writes `.private/training/import/notion-history.json` from two independent reads: day pages set by set, and Progress verbatim. `reconcile` recomputes every Progress total through the phone's own math and refuses to write while a mismatch stands without a stated waiver. Ids derive from date and day, so it re-runs, and a row Dylan has since edited is listed as a conflict and left alone. It writes no workouts. Weigh-ins older than fuel's first are skipped by default because they move past targets, and the dry run prints the largest shift. The route and the import code are deleted at cutover.

`scripts/import-history.mjs` sends that file to `POST /api/train/import`, one transaction per kind, written by `import`. The file names its cutover, and a session dated on or after it refuses the whole file. With no weigh-ins in fuel, every Notion weigh-in counts as older, because nothing has seeded the trend yet. A document an earlier import wrote and this file no longer holds is listed, not deleted, and still counts until someone removes it. A cardio-only day becomes a session with no performances and the week row's words as its note.

### What ships first

The phone reports its build on every sync. The first deploy makes the shell skip and flag what it cannot read, and re-pull under a new build. Publish and import refuse until the phone reports that build, which replaces a human remembering to tap the banner.

## Synthesis decision

Two designs competed, and an independent judge traced eight failure scenarios through both, scoring them 25 to 22. The base is the living program (candidate 2), which removes the two-writer week and needs no change to how sync orders or stores documents. `store.sync` only records the phone's build.

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
- We accept depending on T3 running on the mini, which Dylan says it always is, in exchange for no launchd workaround and a thread per run.
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
7. **Import for real and first program.** Totals equal Progress or carry a stated waiver, a re-run writes nothing, and diary days are byte-identical. A cardio-only day known only from a week row becomes a session with no sets, so the show-up chart agrees with what happened.
8. **Read-only Train tab.** A fake clock crosses two Mondays with no writes: the week appears, a retest goes and a note lapses, offline.
9. **Charts.** Tests for the four corruption cases, screenshots in light and dark, on real imported data.
10. **Logging.** Playwright offline survives a reload, a tab switch and a page kill mid-set. Then one real session alongside Notion.
11. **Finish and diary.** Under both budget policies, lifting and cardio minutes do not overlap, and finishing twice leaves one workout.
12. **The schedule.** By running the T3 task now: a run, a second run that stops, a run with the server down, and a run during an open session that leaves its version byte-identical.
13. **Cutover Monday.** Final import, Notion read-only, import code deleted.

## Next implementation step

Unit 1, the tolerant shell, because nothing else can ship safely before it.
