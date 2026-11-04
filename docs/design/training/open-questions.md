# Open questions for training

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-11-03.

## For Dylan

1. **Old weigh-ins.** Notion's weigh-ins are older than fuel's first, and importing older ones moves past calorie targets slightly. The default skips them. The import's dry run will show the largest shift before you decide. On 2026-11-03 fuel held no documents at all, so every Notion weigh-in counts as older and no target exists to move. Choosing now decides where the trend starts: at the oldest Notion weigh-in, or at your next reading on the phone.
2. **Add-weight hint.** It needs the full prescribed set count, so cutting a last round for time means no hint that week. Is that right?
3. **Rest alerts.** iOS should give a Home Screen app no alert while the phone is locked, so the timer reads right on return but cannot buzz you. Tried on the phone in unit 10.
4. **Cutover Monday.** You keep logging in Notion until then. Pick it once logging has passed a real session.
5. **A pin on a replaced copy.** The calendar rule freezes a version from its date on, but an upcoming version can still be replaced before that. A phone that slept through the replacement pins the copy it holds, and its next sync swaps that copy under the open session. The simulation found this and a route test pins it. Unit 10 answers what the card does: it moves to the new plan, a slot the new plan lacks leaves the plan with its sets still stored, and a test pins that. Closing it means never replacing an upcoming version, or a session holding its plan by value. Left as it is for now.

6. **A day has no note.** Closed in unit 8. A program note can name a day with `day`, and then shows only on that day's preview. The coach prompt says so, and publish refuses a day the version lacks. The first program's notes titled by day stay on the week until the coach moves them.
7. **A cue has no `onlyWeek`.** Blocks and notes can lapse by themselves, and a cue saying "this week" stays until the coach rewrites it.
8. **A session with no row.** A cardio-only or off-plan session counts in "2 of 5 done" and fills a strip segment, but the day list has no row for it, because the approved screen lists planned days. Say if you want a muted line for it.
9. **Sunday's report.** The coach publishes on Sunday for Monday, and the Train tab shows the current week, so that report stays out of sight until Monday. Say if Sunday should show it.
10. **Finish with nothing done.** Finish sets `finishedAt` and `sessionsDone` counts any finish, so a mistaken Start then Finish would mark the day done and reach the coach. Unit 10 removes such a session instead, with an undo. Say if it should count.
11. **A forgotten session with no timed set.** Ticks, skips or a note with no set leave it unfinished, because there is no last set to finish at, so that day does not count. A session with nothing at all is removed.
12. **A set on a lift never loaded.** A swap to a new name starts on a blank weight. Bodyweight and Band appear under a blank weight so that swap can log, which the mockup did not show.

## Assumptions to check

- A T3 scheduled task can run the coach unattended on Sunday morning. Not yet run. Unit 12 proves it. `claude -p` under launchd hung in five configurations, so launchd is only the fallback.
- A screen wake lock works in a Home Screen app. A guess until tried on the phone.
- The session clears the real iOS keyboard, and panning while it opens does not fight the layout. Checked only against a keyboard reported the way iOS reports one, because Playwright shows none.
- Est. 1RM on a per-side set reads the better side. The import reconciliation will show what the Notion routine did.
- Screens draw fast enough on the iPhone. Storage is measured there, drawing is not. Desktop WebKit paints the Train tab's list by 48 ms, and the iPhone's number waits for a deploy.
- Rolling the server back past a kind it has already stored makes every sync fail until it rolls forward (probed). No data is lost, because the phone keeps its outbox. Accepted, since rolling forward is the fix.
- What runs the Notion weekly job today is unknown. The listed cloud routine is disabled, and week pages were created at irregular times. Whatever it is must stop at cutover.
