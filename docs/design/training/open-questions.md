# Open questions for training

Deferred decisions and unstated assumptions for [design.md](design.md), as of 2026-11-03.

## For Dylan

1. **Old weigh-ins.** Notion's weigh-ins are older than fuel's first, and importing older ones moves past calorie targets slightly. The default skips them. The import's dry run will show the largest shift before you decide.
2. **Coach sees nutrition.** The default gives the coach weekly average calories and protein from your diary, since it now lives beside them. Say if you would rather keep training and food separate.
3. **Add-weight hint.** It needs the full prescribed set count, so cutting a last round for time means no hint that week. Is that right?
4. **Rest alerts.** iOS should give a Home Screen app no alert while the phone is locked, so the timer reads right on return but cannot buzz you. Tried on the phone in unit 10.
5. **T3 on Sunday mornings.** The coach runs through T3, so T3 has to be open on the mini at 07:00. If it often is not, the fallback is launchd with its own login token.
6. **Cutover Monday.** You keep logging in Notion until then. Pick it once logging has passed a real session.

## Assumptions to check

- A T3 scheduled task can run the coach unattended on Sunday morning. Not yet run. Unit 12 proves it. `claude -p` under launchd hung in five configurations, so launchd is only the fallback.
- A screen wake lock works in a Home Screen app. A guess until tried on the phone.
- Est. 1RM on a per-side set reads the better side. The import reconciliation will show what the Notion routine did.
- The set and last-time costs hold on the iPhone. Only desktop WebKit has been measured.
- What runs the Notion weekly job today is unknown. The listed cloud routine is disabled, and week pages were created at irregular times. Whatever it is must stop at cutover.
