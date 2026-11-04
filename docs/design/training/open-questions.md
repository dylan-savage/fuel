# Open questions for training

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-11-03.

## For Dylan

1. **Old weigh-ins.** Notion's weigh-ins are older than fuel's first, and importing older ones moves past calorie targets slightly. The default skips them. The import's dry run will show the largest shift before you decide. On 2026-11-03 fuel held no documents at all, so every Notion weigh-in counts as older and no target exists to move. Choosing now decides where the trend starts: at the oldest Notion weigh-in, or at your next reading on the phone.
2. **Add-weight hint.** It needs the full prescribed set count, so cutting a last round for time means no hint that week. Is that right?
3. **Rest alerts.** iOS should give a Home Screen app no alert while the phone is locked, so the timer reads right on return but cannot buzz you. Tried on the phone in unit 10.
4. **Cutover Monday.** You keep logging in Notion until then. Pick it once logging has passed a real session.
5. **A pin on a replaced copy.** The calendar rule freezes a version from its date on, but an upcoming version can still be replaced before that. A phone that slept through the replacement pins the copy it holds, and its next sync swaps that copy under the open session. The simulation found this and a route test pins it. Sets are safe, because a performance holds its target and label by value. What the session card does when its plan moves is unknown until unit 10. Closing it means never replacing an upcoming version, or a session holding its plan by value. Left as it is for now.

6. **A day has no note.** The plan's `Day` has minutes and blocks, while each Notion day opens with a callout. The first program keeps them as week notes titled by day, so they show at the top of the week rather than on that day. A `note` on `Day` would put them back. Decide it before unit 8 builds the screen.
7. **A cue has no `onlyWeek`.** Blocks and notes can lapse by themselves, and a cue saying "this week" stays until the coach rewrites it.

## Assumptions to check

- A T3 scheduled task can run the coach unattended on Sunday morning. Not yet run. Unit 12 proves it. `claude -p` under launchd hung in five configurations, so launchd is only the fallback.
- A screen wake lock works in a Home Screen app. A guess until tried on the phone.
- Est. 1RM on a per-side set reads the better side. The import reconciliation will show what the Notion routine did.
- Screens draw fast enough on the iPhone. Storage is measured there, drawing is not. Checked when the Train tab exists.
- Rolling the server back past a kind it has already stored makes every sync fail until it rolls forward (probed). No data is lost, because the phone keeps its outbox. Accepted, since rolling forward is the fix.
- What runs the Notion weekly job today is unknown. The listed cloud routine is disabled, and week pages were created at irregular times. Whatever it is must stop at cutover.
