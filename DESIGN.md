# Fuel's design rules

Fuel is one person's food and lifting log on an iPhone, used one-handed, often mid-set. It should sit beside native iOS apps and disappear into the task. The owner's complaint on 2026-11-04 was that it reads as busy, with too many words, and that the context in it is good but badly organized. These rules fix that for the whole app, calorie tracker and trainer alike.

This is a simplification of the existing look, not a new brand. iOS system colors and fonts stay. Features stay, unless this file says one goes.

## The rules

1. **One screen, one job.** Each screen names its one primary action. That action is the only filled blue control on screen.
2. **Numbers first, words on request.** A row shows a name and a number. Explanations, cues, formulas and history open on a tap. No row carries more than one line of muted text.
3. **Say it once.** Nothing repeats what is already on screen: no heading that restates its only row, no caption that restates its heading, no subtitle that restates a selected control.
4. **Plain nouns.** A section heading is a noun, such as "Key lifts". Never a question, and never a sentence.
5. **One container.** Content lives in grouped list rows (`.list`) or a single summary card. Never a stack of paragraph cards, and never a card in a card.
6. **Blue means act.** Blue is for the primary action and small text actions. A row that navigates is black text with a chevron. Status and macro colors stay, on small marks only.
7. **Four text sizes.** 28 for a screen title, 22 for a hero number, 17 for row text, 13 for muted detail. Weight does the rest. Drop the 15, 14, 19, 12 and 11 steps wherever a screen is touched.
8. **Empty stays quiet.** An empty thing takes one short line or no space at all. It does not explain the app.
9. **Copy is short.** Cut every string in half, then again. Use the words he uses: "est. max", not "est. 1RM".

## The app's shape

Four tabs: Diary, Add, Train, Goal. The Scan tab goes, and scanning becomes a button in Add's search row.

## Trainer

**Train tab.**
- Title "Week of Nov 2", then "1 of 5 done" with the strip. "Minimum 3" moves to Progress.
- The next day is the hero: its label, "35 min · 8 exercises", and Start as the screen's one primary action. Tapping the card previews the day.
- The other days are plain rows: label, then "Done Mon" or a chevron.
- Then three rows with chevrons: Coach, Progress, Program. Coach shows one truncated line of the report. A "Weigh in" row appears only when today has no weigh-in.
- Week notes, chips and the What changed link all leave this screen.

**Coach sheet.** Everything the coach says, in one place, in this order: the report in full, What changed, This week's notes as plain rows with no "More" links, then "Tell the coach" with its text box at the bottom.

**Day preview.**
- A one-lift block has no heading. A superset gets one short label: "Superset · 3 rounds · rest 60s".
- An exercise row shows the name, "3 × 10–15" at the right, and one muted line with last time: "60 lb × 12/12/12 · Oct 14". Mixed weights read as a range, "40–60 lb × 12/12/12". Tapping the row expands the swaps, the rest time and the cue.
- A checklist is one row, "Warm-up · 3 moves", that expands.
- Optional blocks collapse into one row at the end.
- A day note is one line that expands.

**Session.** A focus screen for one exercise, not a plan with a card below it.
- Top: day label, elapsed time, Finish, and one thin progress bar of sets done.
- Middle: the exercise name large, "Set 2 of 3", the target, last time, and an "Add weight" mark when earned. Sets logged so far today sit under it as small tappable values.
- Rest shows as a clear timer in place when it runs, with "Next: Cable lateral raise".
- Bottom, in thumb reach: the load and reps steppers, with the unit as a small toggle beside the load, then Log set. Below it, quiet text actions: Swap, Skip, Note, Cue, Warm-up.
- The whole plan moves into a "Plan" sheet opened from the top, which still jumps to any exercise.

**Progress.** No question headings and no captions.
- "1 of 5 this week" with the twelve-week chart, and its minimum line labelled once.
- "Key lifts": a key lift with nothing in 12 weeks is left out. If that leaves fewer than three, fill from recently logged lifts.
- A row for All lifts.

**Lift sheet.** No question headings.
- First the next step: "8 reps from adding weight" and its bars.
- Then the est. max number, the chart, and a quiet range control.
- Then recent sessions as plain rows. The legend goes, because the chart labels its own series directly.

## Calorie tracker

**Diary.**
- The summary is "1,120 left", with "1,140 of 2,260" beside it, one thin bar, and three macro numbers. The equation goes.
- Water, fasting and weight become one quiet row of three numbers, with no rings, no sparkline and no buttons. Each opens its sheet, which holds its actions. Log water, Start fast and Weigh in live there.
- Each meal is a heading with its calories and a small plus, and its foods as rows. Tapping the heading opens what its "…" menu held. A meal with no food is one quiet line. Workouts follow the same pattern, and the footnote goes.

**Add.**
- The meal control stays, and the subtitle goes.
- The search field holds a scan button.
- The AI row and the Plate photo and Label photo buttons go, because there is no key and the owner said he does not need them. Delete the client code they leave unused.
- Quick add and New food become two quiet text actions.
- The Recent, Recipes and Saved meals control stays above the list.

**Log food sheet.** The number and its macros on one line, the amount, servings, then Log. Fiber, sugar and sodium open on a tap. The meal control goes, because the meal was already chosen. Edit food stays as a quiet text action.

**Goal.**
- The daily target and its macros first.
- Then rows with their current value and a chevron: Your details, Weight, Activity, Weekly goal, Macros, Water. Each expands or opens to edit.
- Workouts counting toward the target is one toggle with a one-line description.
- The formula moves behind "How this is worked out".
- Save appears only when something has changed.

**Other sheets.** Water, Fasting, Weight, Workouts, Recipes, Saved meals and the food forms keep their function and get rules 2 to 9.

## What must not change

- Every feature stays reachable, except the AI entry points named above.
- Accessible names and roles stay. Tap targets stay at 44 points or more.
- Light and dark both work, using the existing tokens.
- Offline behavior and data are untouched. This is a screens and styles change, plus the small reads a screen needs.

## Seeing it

`npm run build && node scripts/ui-review.mjs <label>` copies the live database to `.private/ui-review`, serves the copy on its own port, and walks the training screens on an iPhone-sized WebKit browser, with contact sheets of every shot. `--dark` does dark mode. Food screens come from `npx playwright test e2e/shots.spec.ts`, which writes to `test-results/shots` with invented data, because the live diary is empty. Everything under `.private/` holds real data and never enters git.
