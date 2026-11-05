# Open questions for training

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-11-04.

## For Dylan

1. **Old weigh-ins.** Notion's weigh-ins are older than fuel's first, and importing older ones moves past calorie targets slightly. The default skips them. The import's dry run will show the largest shift before you decide. On 2026-11-03 fuel held no documents at all, so every Notion weigh-in counts as older and no target exists to move. Choosing now decides where the trend starts: at the oldest Notion weigh-in, or at your next reading on the phone.
2. **Add-weight hint.** It needs the full prescribed set count, so cutting a last round for time means no hint that week. Is that right?
3. **Rest alerts.** Closed on 2026-11-04. There is no rest timer any more, and rest shows as plain text under Cue.
4. **Cutover.** Closed on 2026-11-04. Dylan moved to fuel, the final import ran, and its code is gone.
5. **A pin on a replaced copy.** The calendar rule freezes a version from its date on, but an upcoming version can still be replaced before that. A phone that slept through the replacement pins the copy it holds, and its next sync swaps that copy under the open session. The simulation found this and a route test pins it. The day moves to the new plan, a slot the new plan lacks leaves the day with its sets still stored, and a test pins that. Closing it means never replacing an upcoming version, or a session holding its plan by value. Left as it is for now.

6. **A day has no note.** Closed in unit 8. A program note can name a day with `day`, and then shows only on that day's preview. The coach prompt says so, and publish refuses a day the version lacks. The first program's notes titled by day stay on the week until the coach moves them.
7. **A cue has no `onlyWeek`.** Blocks and notes can lapse by themselves, and a cue saying "this week" stays until the coach rewrites it.
8. **A session with no row.** A cardio-only or off-plan session counts in "2 of 5 done" and fills a strip segment, but the day list has no row for it, because the approved screen lists planned days. Say if you want a muted line for it.
9. **Sunday's report.** Closed. The Train tab shows it as soon as it lands.
10. **Finish with nothing done.** Closed on 2026-11-04. There is no Finish, and settling removes a session with nothing in it.
11. **A session with no timed set.** Ticks, skips or a note with no set leave it unfinished, because there is no last set to finish at, so that day does not count. The coach still reads them. A session with nothing at all is removed.
12. **A set on a lift never loaded.** A swap to a new name starts on a blank weight. Bodyweight and Band appear under a blank weight so that swap can log, which the mockup did not show.
13. **A day with no sets to log.** Closed. Cardio logged from a day's plan makes a day with no sets done, as the Notion routine counted it. A checklist alone still does not.
14. **A workout past midnight.** The first set after midnight makes a new session, so one late workout counts as two and writes two diary workouts. Say if a session should stretch across midnight.
15. **Morning and evening on one day.** Both land in one session, and the workout runs first set to last, so a morning set and an evening set read as hours of lifting under eat-back. Say if a long gap should split the minutes.
16. **When the diary's workout appears.** Six idle hours after the last set, at the next launch or return to the app. Under eat-back the day's target moves only then.
17. **A day repeated in a week.** "2 of 5 done" counts sessions, as the show-up chart and the coach do, so the same day on two dates fills two strip segments and one row reads Done.
18. **Sets from an earlier date.** A day shows today's sets only, so a set logged on Monday cannot be edited on Tuesday.
19. **A skip goes back to the day.** The brief asks only that Log set stays put. A skip has nothing left to do on the exercise, so it returns to the list with the row marked and an undo.

## Assumptions to check

- A T3 scheduled task runs the coach unattended: a dry-run test passed on 2026-11-04 from a project backed by this repo, and the first scheduled firing is Sunday 2026-11-08. T3 reports a run as succeeded even when its workspace fails to prepare, so read the thread. `claude -p` under launchd hung in five configurations, so launchd is only the fallback.
- The exercise clears the real iOS keyboard, and panning while it opens does not fight the layout. Checked only against a keyboard reported the way iOS reports one, because Playwright shows none.
- Est. 1RM on a per-side set reads the better side, which matched most of the Notion routine's rows. The add-weight hint reads the weaker side.
- Screens draw fast enough on the iPhone. Storage is measured there, drawing is not. Desktop WebKit paints the Train tab's list by 48 ms, and the iPhone's number waits for a deploy.
- Rolling the server back past a kind it has already stored makes every sync fail until it rolls forward (probed). No data is lost, because the phone keeps its outbox. Accepted, since rolling forward is the fix.
- What runs the Notion weekly job today is unknown. The listed cloud routine is disabled, and week pages were created at irregular times. Whatever it is must stop at cutover.
