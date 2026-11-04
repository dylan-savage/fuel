# Open questions for training

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-11-03.

## For Dylan

1. **Old weigh-ins.** Notion's weigh-ins are older than fuel's first, and importing older ones moves past calorie targets slightly. The default skips them. The import's dry run will show the largest shift before you decide.
2. **Add-weight hint.** It needs the full prescribed set count, so cutting a last round for time means no hint that week. Is that right?
3. **Rest alerts.** iOS should give a Home Screen app no alert while the phone is locked, so the timer reads right on return but cannot buzz you. Tried on the phone in unit 10.
4. **Cutover Monday.** You keep logging in Notion until then. Pick it once logging has passed a real session.
5. **A pin on a replaced copy.** The calendar rule freezes a version from its date on, but an upcoming version can still be replaced before that. A phone that slept through the replacement pins the copy it holds, and its next sync swaps that copy under the open session. The simulation found this and a route test pins it. Sets are safe, because a performance holds its target and label by value. What the session card does when its plan moves is unknown until unit 10. Closing it means never replacing an upcoming version, or a session holding its plan by value. Left as it is for now.

## Assumptions to check

- A T3 scheduled task can run the coach unattended on Sunday morning. Not yet run. Unit 12 proves it. `claude -p` under launchd hung in five configurations, so launchd is only the fallback.
- A screen wake lock works in a Home Screen app. A guess until tried on the phone.
- Est. 1RM on a per-side set reads the better side. The import reconciliation will show what the Notion routine did.
- The set and last-time costs hold on the iPhone. Only desktop WebKit has been measured.
- Rolling the server back past a kind it has already stored makes every sync fail until it rolls forward (probed). No data is lost, because the phone keeps its outbox. Accepted, since rolling forward is the fix.
- What runs the Notion weekly job today is unknown. The listed cloud routine is disabled, and week pages were created at irregular times. Whatever it is must stop at cutover.
