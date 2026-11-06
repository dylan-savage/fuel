# Added exercises, a lift picker that suggests, and notes as lines

Requests 2, 3 and 4 from the Friday workout of 2026-11-06, as one change. Request 1, a load stepper that reaches bodyweight, shipped on its own in 70ae6ba. Status: awaiting the owner's approval.

## Problem

Three things he did on Friday had no honest place in the data.

1. **An exercise off the day's list.** He did calf raises on leg day and had to write them in the day note. The data model already allows it: `performanceId()` takes an absent slot and `Performance.slotId` is optional. But every function from the day row to the intent is keyed by a `Slot`. That covers `slotLog`, `setsInSlot`, `SetPlace`, `withSet`, `afterSet`, `SetCard`, `EditSetSheet`, `ExerciseScreen`, the trainDraft keys and the route. So no screen can make or show a performance with no slot.
2. **Swap only types.** `swapChoices` offers the slot's 0 to 2 listed swaps and then nothing until he types. The catalog has 61 lifts. Nothing in it says which lifts are alike, so "similar first" has no data behind it.
3. **One note per thing.** `session.note` and `performance.note` are single strings that `noteSession` and `noteExercise` replace. The sheet prefills the old text. His second note went to Tell the coach, which already stores one document per line (`TrainingNote`).

Constraints from Phase A that shape the design:

- Old builds must keep reading existing data. Schemas are `z.looseObject`, so a new optional field is safe and a changed field type is not. A stored enum that later gains a value makes an old build fail to parse the whole doc. For a `Program` that empties the Train tab.
- Sync is whole-document and pending local writes win. Two writers on one document lose a write. A read-modify-write on the session also needs `oneAtATime`.
- The program is coach-only. The phone never writes the catalog or a plan.
- DESIGN.md asks for one primary action per screen, no primary action on a day, quiet empties, short copy and plain nouns.
- `SetInputs` stays the only set input, which the bodyweight fix also touches.

## Usage (caller's view)

### What the domain now says

- **An exercise on a day** is `{ slot, lift }`. `slot` is the plan's `Slot`, or `null` for one he added on the spot. `lift` is what he is doing now. This mirrors `Performance { slotId?, liftId }`. Its sets and notes are the rows `isOn(exercise, row)` accepts. An added exercise exists from its first set, because a performance is the proof of one.
- **A note** is one `TrainingNote` document per line. `about` says what the line is about: a day, an exercise or, when absent, the week. Tell the coach, the day's note and an exercise's note are one kind of thing, written by one intent.
- **A lift's muscle** is a coach-written tag on the catalog row. The pickers derive "alike" from it. They also use the plan's own swaps and what he did in that spot before.

### Call sites

The day screen adds an exercise. This is `TrainDay.tsx`.

```tsx
// HeldDay
const [picking, setPicking] = useState(false);
const open = exerciseAt(place.open, view.plan, liftOf);   // Exercise | undefined
const liftIds = dayLiftIds(view, [...Object.values(draft.swaps), ...(open?.slot === null ? [open.lift] : [])]);

// DayScreen, after the required parts and before Optional
{view.added.length > 0 && (
  <section class="plan-section" aria-label="Added">
    <ul class="list">
      {view.added.map((lift) => (
        <li key={lift.liftId}>
          <ExerciseRow exercise={{ slot: null, lift }} {...context} />
        </li>
      ))}
    </ul>
  </section>
)}
// ...Optional...
<div class="quiet-actions start">
  <button type="button" class="text-button" onClick={() => setPicking(true)}>Add exercise</button>
</div>

{picking && (
  <LiftPicker
    title="Add exercise"
    pickFor={{ kind: 'add', onDay: liftsOnDay(view.plan, view.added, liftOf) }}
    day={day}
    lifts={view.lifts}
    book={view.book}
    onPick={(lift) => {
      setPicking(false);
      onOpen({ kind: 'added', lift });
    }}
    onClose={() => setPicking(false)}
  />
)}
```

The exercise screen takes an `Exercise`, so a planned one and an added one share every line. This is `Exercise.tsx`.

```tsx
export function ExerciseScreen({ view, day, exercise, rows, draft, onDraft, onBack }: Props) {
  const { slot, lift } = exercise;
  const log = exerciseLog(exercise, view);
  const logSet = (form: SetForm) =>
    void intents.logSet({ day, exercise }, entryOf(form)).then((undo) => {
      if (undo === null) return;
      onDraft(afterLog(draft, exercise));
      toast({ text: `${lift.label} logged`, undo });
    });
  return (
    <>
      <SetCard exercise={exercise} day={day} rows={rows} book={view.book} performances={view.performances} log={log}
        typed={typedFor(draft, exercise, log.done + 1)} onForm={(form) => onDraft(withTyped(draft, exercise, log.done + 1, form))}
        onLog={logSet} onSwitch={...} onEdit={...}
        actions={slot === null
          ? <CardAction label="Note" onClick={() => setSheet({ kind: 'note' })} />
          : <>{/* Swap, Skip, Note, Cue as today */}</>}
      />
      {sheet?.kind === 'swap' && slot !== null && (
        <LiftPicker title="Swap" pickFor={{ kind: 'swap', slot, current: lift.liftId }} day={day} lifts={view.lifts} book={view.book}
          onPick={(choice) => { onDraft(withSwap(draft, slot.id, choice)); closeSheet(); }} onClose={closeSheet} />
      )}
      {sheet?.kind === 'note' && <NoteSheet view={view} day={day} exercise={exercise} onClose={closeSheet} />}
      {sheet?.kind === 'edit' && <EditSetSheet logged={sheet.row} exercise={exercise} onClose={closeSheet} />}
    </>
  );
}
```

The Note sheet lists earlier lines and always starts on a fresh field. This is `ExerciseSheets.tsx`.

```tsx
export function NoteSheet({ view, day, exercise, onClose }: Props) {
  const [scope, setScope] = useState<'exercise' | 'day'>('exercise');
  const [editing, setEditing] = useState<NoteLine | null>(null);
  const [text, setText] = useState('');
  const target: DayNoteTarget = scope === 'exercise' ? { kind: 'exercise', day, exercise } : { kind: 'day', day, label: view.plan.label };
  const lines = notesOn(target, { notes: view.trainingNotes, session: view.session, performances: view.performances });
  const save = () => {
    onClose();
    const write = editing === null ? intents.addNote(target, text) : intents.editNote(editing, text);
    void write.then((undo) => toast({ text: 'Note saved', undo }));
  };
  const remove = (line: NoteLine) => {
    onClose();
    void intents.editNote(line, null).then((undo) => toast({ text: 'Note deleted', undo }));
  };
  // ...render: Segmented, then lines as rows (tap → setEditing(line); setText(line.text)), then NoteField, then Save note
}
```

Tell the coach becomes the same intent with a week target. This is the `CoachSheet` in `Train.tsx`.

```tsx
void intents.addNote({ kind: 'week', date: today }, text).then((undo) => toast({ text: 'Saved for the coach', undo }));
```

The coach reads note documents by what they are about. The snapshot's note shape does not change. This is `coach.ts` in `snapshotOf`.

```ts
const shownDates = new Set(shown.map((read) => read.session.date));
const lines = docs.trainingNotes.filter((note) => note.date >= firstWeek || shownDates.has(note.date)).map(snapshotNote);
// snapshotNote: about.kind 'day' → source 'session', 'exercise' → 'exercise', absent → 'training'; about = about.label ?? null
```

## Shape

### Data structures

**`src/domain/lifts.ts`.** Add a muscle tag on the catalog row, and teach the book to read it.

```ts
/**
 * What a lift mainly trains, which is what makes two lifts alike to the pickers. Stored as any
 * slug, so a phone a build behind reads a value added later as one more name. checkPublish holds
 * the coach to MUSCLES.
 */
export const Muscle = z.string().regex(SLUG).max(24).brand<'Muscle'>();
export type Muscle = z.infer<typeof Muscle>;

/** What a publish accepts. Append only. The snapshot hands this list to the coach, so the prompt never repeats it. */
export const MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'core', 'quads', 'hamstrings', 'glutes', 'calves', 'full-body'] as const;

export const Lift = z.looseObject({
  id: LiftId,
  name: z.string().min(1).max(80),
  aliases: z.array(LiftId),
  key: z.boolean().optional(),
  /** Absent until the coach places it, which leaves it out of "alike" and nothing else. */
  muscle: Muscle.optional(),
});

export interface LiftBook {
  canonical(id: LiftId): LiftId;
  members(id: LiftId): readonly LiftId[];
  nameOf(id: LiftId): string | undefined;
  has(id: LiftId): boolean;
  /** Through an alias, like nameOf. */
  muscleOf(id: LiftId): Muscle | undefined;
}
```

`Performance`, `performanceId`, `SetLog` and `Target` are unchanged. A slot-less performance was always valid.

**`src/domain/session.ts`.** Add the exercise, which replaces threading a `Slot` everywhere.

```ts
/**
 * An exercise on a day as he is doing it now: a slot with whatever lift is in it, or a lift he
 * added on the spot, which has no slot and is only its lift. Mirrors Performance's optional slotId.
 */
export interface Exercise {
  readonly slot: Slot | null;
  readonly lift: LiftChoice;
}

/** A planned exercise holds every row in its slot, across a swap. An added one holds only slot-less rows of its own lift, so a swap into a slot never lands on it. */
export function isOn(exercise: Exercise, row: { readonly slotId?: SlotId | undefined; readonly liftId: LiftId }): boolean;

/** Was SlotLog. An added exercise has a dot per working set and is never skipped. */
export interface ExerciseLog {
  readonly done: number;
  readonly dots: number;
  readonly skipped: boolean;
  readonly sets: readonly LoggedSet[];
}
export function exerciseLog(exercise: Exercise, logs: Pick<DayLogs, 'session' | 'performances'>): ExerciseLog;

/** The exercises he added that day, in the order he started them. Derived from performances, so there is no list to keep. */
export function addedOn(performances: readonly Performance[]): readonly LiftChoice[];

/** Every lift the day already holds: each slot's planned lift and the one in it now, and what he added. The add picker leaves these out. */
export function liftsOnDay(plan: PlannedDay, added: readonly LiftChoice[], liftOf: (slot: Slot) => LiftChoice): readonly LiftId[];

/** Where a set goes. */
export interface SetPlace {
  readonly session: Pick<Session, 'id' | 'date'>;
  readonly exercise: Exercise;
}
export function performanceIdOf(place: SetPlace): PerformanceId;
/** A first set makes the performance. A planned one carries slotId, target, and plannedLiftId on a swap. An added one carries none of them. */
export function withSet(place: SetPlace, before: Performance | undefined, set: SetLog): Performance;
/** A set on an added exercise has no skip to take back, so it only reopens a settled session. */
export function afterSet(session: Session, slotId: SlotId | undefined): Session;
```

Deleted from `session.ts`: `slotLog`, `SlotLog`, `setsInSlot` (folded into `exerciseLog` through `isOn`), `swapChoices`, `SwapChoices`, and `TrainingNote` (moved to `notes.ts`). `liftInSlot`, `cueFor`, `prefillSet`, `leftEmpty` and the settle functions stay as they are. `prefillSet` already takes `target: undefined`.

**`src/domain/notes.ts` (new).** One body of knowledge: what he wrote, what it is about, and the one read of it.

```ts
const label = z.string().min(1).max(80);

/** What a line is about, by value, so it still reads after the plan moves on. An exercise is matched the way its sets are. */
export const NoteAbout = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('day'), key: DayKey, label }),
  z.looseObject({ kind: z.literal('exercise'), key: DayKey, slotId: SlotId.optional(), liftId: LiftId, label }),
]);
export type NoteAbout = z.infer<typeof NoteAbout>;

/**
 * A line he wrote for the coach. One document per line, so lines written on two phones offline
 * both survive and editing one never rewrites another. Absent `about` is a line about the week,
 * as Tell the coach writes. Written only by the phone.
 */
export const TrainingNote = z.looseObject({
  id: TrainingNoteId,
  date: LocalDate,
  text: z.string().min(1).max(2000),
  at: Millis,
  about: NoteAbout.optional(),
});
export type TrainingNote = z.infer<typeof TrainingNote>;

/** What a new line is about. */
export type NoteTarget =
  | { readonly kind: 'week'; readonly date: LocalDate }
  | { readonly kind: 'day'; readonly day: DayRef; readonly label: string }
  | { readonly kind: 'exercise'; readonly day: DayRef; readonly exercise: Exercise };
/** The targets the Note sheet lists lines for. */
export type DayNoteTarget = Exclude<NoteTarget, { readonly kind: 'week' }>;

/** Where a line is stored. This build writes only `note`. The other two are what older builds kept, read until he touches them. */
export type NoteRef =
  | { readonly kind: 'note'; readonly id: TrainingNoteId }
  | { readonly kind: 'session'; readonly id: SessionId }
  | { readonly kind: 'performance'; readonly id: PerformanceId };

/** One line as the sheet shows and edits it. `about` is what an edit of an older build's line moves into. */
export interface NoteLine {
  readonly ref: NoteRef;
  readonly text: string;
  readonly date: LocalDate;
  readonly about: NoteAbout;
}

/** The stored `about` of a target. Null for the week. */
export function aboutOf(target: NoteTarget): NoteAbout | null;
/** The document a new line makes. Null for blank text, which writes nothing. */
export function noteOf(target: NoteTarget, text: string, stamp: { readonly id: TrainingNoteId; readonly at: Millis }): TrainingNote | null;
/**
 * The lines on a day or one of its exercises, in the order written: an older build's line first,
 * because it kept no time, then documents by `at`. A line of another day on the same date is not
 * this day's.
 */
export function notesOn(target: DayNoteTarget, logs: { readonly notes: readonly TrainingNote[]; readonly session: Session | null; readonly performances: readonly Performance[] }): readonly NoteLine[];
```

**`src/domain/picks.ts` (new).** One pure function behind both pickers.

```ts
/** How far back the pickers look for what he did on this day. */
export const PICK_WEEKS = 8;

/** What a picker chooses for. */
export type PickFor =
  | { readonly kind: 'swap'; readonly slot: Slot; readonly current: LiftId }
  | { readonly kind: 'add'; readonly onDay: readonly LiftId[] };

export interface PickList {
  /** The plan's own choices and what he did here before, in that order, then lifts for the same muscles, most recently done first. Short. */
  readonly suggested: readonly LiftChoice[];
  /** Everything else, A–Z, never repeating a suggestion. */
  readonly others: readonly LiftChoice[];
  /** The search as a new lift, when it slugs and nothing offered is it. */
  readonly typed: LiftChoice | null;
}

/**
 * The choices, from the catalog and every name he has logged that the catalog has not placed,
 * once each under its canonical id. A search filters both lists by name or alias, and keeps the
 * order.
 */
export function pickList(input: {
  readonly pickFor: PickFor;
  readonly lifts: readonly Lift[];
  readonly book: LiftBook;
  /** Each lift's newest row, from newestOfEachLift. */
  readonly newest: readonly Performance[];
  /** This day's sessions in the PICK_WEEKS before the date. */
  readonly dayHistory: readonly Performance[];
  readonly query: string;
}): PickList;
```

The ranking is four tiers, decided in one place.

| Tier | Swap | Add exercise |
|---|---|---|
| 1. The plan's own | The slot's planned lift when he has left it, then its listed swaps, with their plan labels | None |
| 2. Here before | Lifts he did in this slot on this day in the last 8 weeks, newest first | Lifts he added to this day in the last 8 weeks, newest first |
| 3. Alike | Lifts whose muscle is the slot lift's muscle, most recently done first | Lifts whose muscle is one of the day's muscles, most recently done first |
| 4. Others | Everything else, A–Z | Everything else, A–Z |
| Left out | The lift he is on | Every lift already on the day |

`suggested` is tiers 1 and 2 uncapped, then tier 3 up to 8 in total. Tier 3's overflow joins `others`. Everything dedupes on `book.canonical`. A search keeps both lists and their order but filters them, so there is no separate search mode.

**`src/domain/coach.ts`.** The snapshot keeps its note shape and gains two fields.

```ts
export interface SnapshotExercise {
  // ...as today
  /** Not on the day's plan: he added it on the spot. Only in a session pinned to a plan, so an import's exercises never read as added. */
  readonly added: boolean;
}
export interface CoachSnapshot {
  // ...as today
  /** The values a lift's `muscle` may take. */
  readonly muscles: readonly string[];
}
export type ProblemCode = /* ...as today */ | 'unknown-muscle';
function muscleProblems(draft: ProgramDraft): readonly Problem[];   // added to checkPublish
function snapshotNote(note: TrainingNote): SnapshotNote;            // replaces the inline trainingNotes map
```

`notesOf` keeps reading the legacy `session.note` and `performance.note`, skip notes and set notes, unchanged. `programDiff` ignores `muscle`. It is picker metadata, not a training change, and 61 backfill items in What changed would bury the real ones. `sameContent` still sees it, so a muscle-only draft publishes.

### Client

**`src/client/views.ts`.**

```ts
export interface DayScreenView extends DayLogs {
  // ...as today
  /** Exercises he added that day, from addedOn. */
  readonly added: readonly LiftChoice[];
  /** That date's lines, which the Note sheet lists. */
  readonly trainingNotes: readonly TrainingNote[];
}

export interface PickerView {
  readonly newest: readonly Performance[];
  readonly dayHistory: readonly Performance[];
}
/** What the pickers rank by: each lift's newest row, and this day's sessions in the PICK_WEEKS before the date. Read while a picker is open. */
export async function pickerView(r: ReplicaReader, day: DayRef): Promise<PickerView>;
```

`pickerView` makes three reads: `newestOfEachLift()`, plus `between('session', …)` and `between('performance', …)` over the window ending the day before, filtered to sessions whose `day.key` matches. `dayScreenView` adds `onDate('trainingNote', date)`, which the existing `doc.date` index serves.

**`src/client/intents.ts`.**

```ts
/** Stores a set at its tap, on a planned or an added exercise. ...rest of today's doc. */
logSet(place: { readonly day: DayRef; readonly exercise: Exercise }, entry: SetEntry): Promise<Undo | null>;
/** One more line, as its own document, so it needs no queue and competes with nothing. Blank text writes nothing. */
addNote(target: NoteTarget, text: string): Promise<Undo>;
/**
 * Rewrites one line, keeping its time, or removes it when `text` is null. A line an older build
 * kept on the session or an exercise moves into its own document in the same commit, so this
 * build only ever empties those fields.
 */
editNote(line: NoteLine, text: string | null): Promise<Undo>;
```

Deleted: `noteExercise`, `noteSession`, `tellCoach`. Their callers move to `addNote` in the same change. `editNote` runs in `oneAtATime` because a legacy line rewrites a session or a performance. `addNote` touches no shared document.

**`src/client/trainDraft.ts`.** Typed digits are keyed by exercise: `s:<slotId>` for planned and `a:<liftId>` for added. The prefixes rule out a collision. Swaps stay keyed by slot.

```ts
export function typedFor(draft: TrainDraft, exercise: Exercise, set: number): SetForm | undefined;
export function withTyped(draft: TrainDraft, exercise: Exercise, set: number, form: SetForm): TrainDraft;
/** Drops the exercise's typed digits, and a planned one's pre-set swap. */
export function afterLog(draft: TrainDraft, exercise: Exercise): TrainDraft;
export function withSwap(draft: TrainDraft, slotId: SlotId, lift: LiftChoice): TrainDraft;   // unchanged
```

**Route.** This is client-only, so it lives in `TrainDay.tsx` and `Train.tsx`, not the domain.

```ts
/** Which exercise is open: a slot by id, or an added lift, which needs its label before it has a set. */
export type OpenExercise = { readonly kind: 'slot'; readonly slotId: SlotId } | { readonly kind: 'added'; readonly lift: LiftChoice };
export type TrainPlace = { readonly key: DayKey; readonly open: OpenExercise | null } | null;
/** Undefined when the slot left the plan, which lands him on the day. */
function exerciseAt(open: OpenExercise | null, plan: PlannedDay, liftOf: (slot: Slot) => LiftChoice): Exercise | undefined;
```

**Components.**

- `src/client/screens/LiftPicker.tsx` is new and is the one picker. Props are `{ title, pickFor, day, lifts, book, onPick, onClose }`. Inside it reads `useLive(pickerView)`, holds `query` state and calls `pickList`. It replaces `SwapSheet` and `ChoiceList`.
- `SetCard` takes `exercise` in place of `slot` and `lift`. It reads `target = exercise.slot?.target`, `prompt = exercise.slot?.setPrompt`, and the swap hint only when `slot !== null`.
- `EditSetSheet` takes `exercise` in place of `slot`.
- `ExerciseRow` takes `exercise`. A planned row shows `prescriptionText` and dots of `log.dots`. An added row shows dots only.
- `NoteSheet` is rewritten as described in [Usage](#usage-caller-s-view).
- `format.ts` changes `setOfText(target: Target | undefined, set)`. With no target it reads "Set 2".

### Module map

| File | Change |
|---|---|
| `src/domain/lifts.ts` | `Muscle`, `MUSCLES`, `Lift.muscle?`, `LiftBook.muscleOf` |
| `src/domain/session.ts` | `Exercise`, `isOn`, `exerciseLog`, `addedOn`, `liftsOnDay`. `SetPlace`, `withSet` and `afterSet` take an exercise. Deletes `slotLog`, `setsInSlot` and `swapChoices`. `TrainingNote` moves out |
| `src/domain/notes.ts` | New. `TrainingNote` with `about`, `NoteAbout`, `NoteTarget`, `NoteRef`, `NoteLine`, `aboutOf`, `noteOf`, `notesOn` |
| `src/domain/picks.ts` | New. `PickFor`, `PickList`, `pickList`, `PICK_WEEKS` |
| `src/domain/kinds.ts` | Imports `TrainingNote` from `notes.ts`. No Dexie layout change and no `SCHEMA_HISTORY` entry |
| `src/domain/coach.ts` | `SnapshotExercise.added`, `CoachSnapshot.muscles`, `snapshotNote`, `muscleProblems` and `'unknown-muscle'` |
| `src/client/views.ts` | `DayScreenView.added` and `.trainingNotes`, `pickerView` |
| `src/client/intents.ts` | `logSet` takes an exercise. Adds `addNote` and `editNote`. Deletes `noteExercise`, `noteSession` and `tellCoach` |
| `src/client/trainDraft.ts` | Typed digits keyed by exercise |
| `src/client/screens/Train.tsx` | `TrainPlace.open`. `CoachSheet` calls `addNote` |
| `src/client/screens/TrainDay.tsx` | `OpenExercise`, `exerciseAt`, the Added list, Add exercise, the picker |
| `src/client/screens/Exercise.tsx` | Takes an `Exercise`. Actions depend on `slot` |
| `src/client/screens/SetCard.tsx` | Takes an `Exercise` |
| `src/client/screens/ExerciseSheets.tsx` | New `NoteSheet`. `EditSetSheet` takes an exercise. `SwapSheet` is gone |
| `src/client/screens/LiftPicker.tsx` | New |
| `src/client/screens/format.ts` | `setOfText` with an optional target |
| `scripts/coach-prompt.md` | Three sentences, listed under [Compatibility](#migration-and-compatibility) |
| `DESIGN.md` | Lines for the added rows, Add exercise, the picker and the Note sheet |

A trace from tap to storage reads three files: `TrainDay.tsx`, then `intents.ts`, then `session.ts` or `notes.ts`.

### Load-bearing decisions

- **An added exercise is `slot: null`, and it exists from its first set.** There is no "added" list on the session. `addedOn(performances)` derives the day's rows, so undo and delete need no second path. Undo of the first set's toast deletes the new performance, and the row goes. Deleting the last set in Edit set removes the performance, and the row goes. Per **model-the-domain**, the structure mirrors `Performance.slotId?` instead of adding a parallel concept.
- **One `isOn(exercise, row)` decides membership** for sets, dots, prefill, the swap hint and notes. Planned matches by slot. Added matches slot-less rows of its lift. Each rule is stated once, per **laziness-protocol**.
- **Notes are documents, one per line.** Per **separate-before-serializing-shared-state**, two lines are two independent facts. They should not compete for one session field under whole-document sync. `addNote` needs no queue, and an exercise note no longer waits for a set.
- **The legacy note fields are read, never written, except to be emptied.** They stay in the schemas because old builds and restores can still bring them. `notesOn` folds them in on the phone and `notesOf` already reads them for the coach. `editNote` moves a legacy line into a document on first touch.
- **`muscle` is loose in storage and strict at publish.** Per **boundary-discipline**, the coach's draft is the boundary where the vocabulary is enforced. The stored schema accepts any slug, so a value added later can never make an old build drop the program. The phone only compares muscles for equality and never needs the list.
- **One picker, one ranking function.** `PickFor` names the only difference between swap and add. Both read the same sources and share search and new-name typing.

### Interface depth

- `LiftPicker` takes seven props and hides a lot: two reads, the merge of catalog and logged names, alias folding, four tiers, the cap, search, and new-name typing. `pickList` is the whole policy as one pure call.
- Notes go from three intents with three behaviors to two. `addNote` covers all three targets. `editNote` hides where a line is stored and the legacy conversion.
- `Exercise` replaces a `Slot` threaded through six signatures with one value. The screens stop asking "is there a slot" except to choose actions.

What stays exposed: `isOn`, because sets and notes both need it, and `NoteRef`, inside `NoteLine`. Callers pass `NoteRef` through without reading it.

### What the design does not do

- It shows no added row before its first set. A picked-and-abandoned exercise leaves no trace, like an emptied session.
- Added exercises get no Swap, Skip or Cue. A wrong pick before a set is Back. After a set, it is Delete set.
- The day screen does not show his notes, and the note rows show no times.
- The phone does not edit `muscle`. The coach places it, as it places uncataloged names.
- There is no new document kind, no Dexie index and no `SCHEMA_HISTORY` entry.

## UI flow per screen

These follow DESIGN.md. Every new string is two words or fewer except `Use "…"`.

**A day.**

- The plan rows stay unchanged.
- Added exercises follow the required parts as their own grouped list with no visible heading (aria-label "Added"). Each row is the name, a dot per working set with all of them filled, and the muted last-time line. A tap opens the exercise.
- Optional stays one row at the end of the lists.
- The last line on screen is a quiet text action, "Add exercise". The day still has no primary action.
- The "35 min · 8 exercises" line counts the plan only.

**Add exercise sheet.** This is `LiftPicker`, with dialog name "Add exercise".

- A search field labelled "Another lift", the existing accessible name, with placeholder "Search or type a name". It is not focused on open, so no keyboard covers the suggestions.
- Suggestions, as a list with no heading (aria-label "Suggested").
- Then the heading "All lifts" and the rest, A–Z.
- Typing filters both lists in place. When the text slugs to a name nothing offered has, a last row reads `Use "…"` (list "New lift").
- A tap closes the sheet and opens the exercise.

**Swap sheet.** It is the same component, with dialog "Swap". Picking holds the swap in the draft, as today.

**An exercise, added.**

- The name large.
- "Set 2". With no target there is no "of 3", no reps line and no "Extra set".
- "Last 45 lb × 15/15/12 · Oct 31" when he has done the lift.
- Today's sets as small tappable values, then the steppers prefilled from last time.
- Log set as the primary action.
- Quiet actions: Note and Warm-up.

**Note sheet.**

- The Segmented control "This exercise" or "Today", which now always shows on an exercise, because a note no longer needs a set.
- Earlier lines of that scope as plain rows (list "Earlier notes"), oldest first. A tap edits that line.
- An empty field, then Save note as the primary action, disabled while blank. Save closes the sheet with "Note saved" and Undo.
- Reopening shows the new line among the rows and a fresh field. That is request 4.
- Editing a line titles the sheet "Edit note", prefills the field and hides the rows. Save note rewrites the line. A quiet destructive "Delete note" removes it, with "Note deleted" and Undo. This mirrors Edit set.

**Coach sheet.** Unchanged on screen. Tell the coach calls `addNote({ kind: 'week' })`.

## Migration and compatibility

| Data | Old phone build | Coach and server | This build |
|---|---|---|---|
| Slot-less `Performance` | Parses (`slotId` was always optional). It shows no row for it, but it counts toward the week and feeds last time | `snapshotExercise` handles it. `added: true` is the new flag | Writes and shows it |
| `TrainingNote.about` | `looseObject` keeps the field. Old builds never display training notes, and their Tell the coach still writes loose lines | Reads `about` into `source` and `about`. Without `about` a line reads as 'training', as today | Writes every note as a doc |
| `session.note`, `performance.note` | Still writes and prefills them | `notesOf` reads them, unchanged | Reads them as lines. Writes them only to remove them, on `editNote` |
| `Lift.muscle` | `looseObject` keeps the field | Publish refuses a value outside `MUSCLES`. Stored values are any slug, so later additions are safe | Ranks by it. A missing tag only drops tier 3 |
| `leftEmpty` | Unchanged | Unchanged | Unchanged. It still checks the legacy `session.note` |
| Dexie layout | Unchanged | n/a | Unchanged. `trainingNote` already has `doc.date` |
| trainDraft in localStorage | n/a | n/a | New key format. Digits typed before the update are dropped once, which costs retyping one set |
| Route state | n/a | n/a | In memory only, as today |

Two behavior changes are deliberate.

- A day note no longer makes a session. A note-only session never counted as done (`sessionsDone` needs a finish or a working set), so the week strip and settling are unchanged. The coach sees the line with its day label and no empty session around it.
- An exercise note no longer waits for a set.

There is no backfill migration. Legacy lines convert when touched, and imports keep theirs in place.

`scripts/coach-prompt.md` gains four sentences.

- "Every lift in `lifts` carries a `muscle`, one of `muscles`, for what it mainly trains. Give any lift without one its muscle. The phone offers lifts of the same muscle first when he swaps or adds."
- "`added: true` marks an exercise he put on the day himself. One he adds to the same day week after week is grounds for a slot."
- "A day or an exercise can carry several notes, each its own entry."
- "Give each slot two to four `swaps` he can do on other equipment, closest first. A lift he swapped to in a slot more than once belongs in that slot's `swaps`." (From runner 1.)

The first publish after deploy backfills `muscle` on all 61 lifts. Until then the pickers still suggest from the plan and his history.

## Test plan

Each item names what a user or the coach can observe, per **test-behavior-not-implementation**.

### Vitest

`test/session.test.ts`:

- `exerciseLog`: an added exercise fills a dot per working set, is never skipped, and ignores a slotted row of the same lift. These are the existing `slotLog` cases, moved.
- `isOn`: a planned exercise holds a swap in its slot. An added one holds only slot-less rows of its own lift.
- `withSet` on an added exercise makes `pf:<session>::<lift>` with no slotId, target or plannedLiftId, and it parses as a `Performance`.
- `afterSet` with no slot reopens a settled session and leaves a skip of another slot.
- `addedOn` lists slot-less lifts in the order of their first set.

`test/notes.test.ts`, new:

- `noteOf`: blank text makes nothing. Each target stores its `about` by value, and a week line has none.
- `notesOn` lists the older build's line first, then documents by time. It keeps another day's line on the same date off, and matches an exercise line the way its sets are matched, across a swap.
- A `TrainingNote` with no `about`, as an old build wrote it, still parses.

`test/picks.test.ts`, new, replacing the `swapChoices` cases:

- With no search, a swap offers the plan's own lift and its listed swaps first with their labels, then what he swapped to here before, then same-muscle lifts most recently done first, up to eight.
- `others` is A–Z and never repeats a suggestion or the lift he is on.
- Add leaves out every lift on the day, puts what he added to this day before first, and ranks the day's muscles next.
- A search filters both lists by name and by alias slug. It offers an uncataloged name he logged. It offers `Use "…"` only for a slug nothing offered has.
- With no muscle anywhere, suggestions are the plan's own choices and his history, and nothing breaks.

`test/lifts.test.ts`:

- `Lift` parses with no muscle and with a slug outside `MUSCLES`.
- `muscleOf` follows an alias.

`test/coach.test.ts`:

- `checkPublish` refuses `muscle: 'quadz'` with 'unknown-muscle' and accepts an absent one.
- `programDiff` names nothing for a muscle-only change, and `sameContent` sees it.
- `snapshotOf` reads a day doc as a 'session' note with the day label, an exercise doc as 'exercise' with the lift label, and a loose doc as 'training'. Legacy fields still read. It keeps a doc dated with a late session older than the window. `added` is true only for a slot-less row in a pinned session, never on an import.

`test/session.intents.test.ts`:

- `logSet` on an added exercise makes the session when new and writes one slot-less performance. Its undo removes both. A second set appends.
- `addNote` writes one document per line and nothing for blank text. Its undo deletes the line. Two notes on the same day stay two documents.
- `editNote` on a document keeps its id and time, and null deletes it.
- `editNote` on an older build's session line writes a document and empties `session.note` in one commit, and its undo puts both back. The same holds for `performance.note`.

`test/train.views.test.ts`:

- `dayScreenView` holds that date's added exercises and lines.
- `pickerView` reads only this day's sessions inside the window.
- `dayLiftIds` asks last time of an added lift before its first set.

### Playwright (WebKit iPhone)

`e2e/train.session.spec.ts` gets three new tests and one edit.

1. **An exercise off the list logs from Add exercise, shows on the day, and leaves with its last set.** Seed last week's leg day with an added calf raise.
   - Open the day and tap Add exercise. Calf raise is the first suggestion, with no typing.
   - Pick it. The card reads "Set 1" with last week's line and no target.
   - Log two sets offline. The toast offers Undo.
   - Back to the day. The row sits after the plan with two filled dots.
   - Edit set, then Delete set twice. The row is gone, and the server holds no slot-less performance.
   - Then add a new name by typing it and log it. The coach snapshot lists it as `added` and uncataloged.
2. **Swap offers alike lifts with no typing.** Seed a catalog with muscles.
   - Swap shows the listed swap, then same-muscle lifts, then All lifts.
   - A tap swaps with no set written.
   - Searching filters, and `Use "Zottman press (seated)"` still works.
   - The existing swap test's `Listed for this slot` assertion moves to `Suggested`.
3. **A second note starts on a fresh field, and an earlier one edits or deletes.**
   - Save a day note, then reopen. The field is empty and the first line is listed.
   - Save a second. The server holds two `trainingNote` docs with `about.kind: 'day'`.
   - Edit the first, then delete the second, then undo. Do the same on "This exercise" before any set.
   - Seed a session with a legacy `note`. It lists first, and editing it leaves `session.note` gone and a doc holding the text.
4. **Tell the coach still writes a loose note with an undo.** This is the existing test, unchanged, and must pass through `addNote`.

`e2e/shots.spec.ts` and `node scripts/ui-review.mjs` give contact sheets, light and dark, for the day with an added row, both picker sheets, and the Note sheet with earlier lines and in edit.

The `older-shell` pattern simulates unknown kinds, and this change adds none. The new fields are optional fields on `looseObject` schemas, which the `notes.test` and `lifts.test` parses above cover.

## Synthesis decision

Two runners designed this independently. They agreed on every structural choice:

- An added exercise is `Exercise { slot: null }`, a performance with no slot, and nothing is stored before its first set.
- One picker and one pure ranking function serve both Swap and Add exercise, and show a list with no typing.
- Each note is its own `TrainingNote` document with an optional field naming the day or exercise. `addNote` and `editNote` replace `noteExercise`, `noteSession` and `tellCoach`.
- The legacy `session.note` and `performance.note` are read, never written except to be emptied, and convert when edited.
- `SnapshotExercise.added` tells the coach, and there is no new kind, Dexie index or `SCHEMA_HISTORY` entry.

That agreement is the strongest signal the arena gives, so the consensus shape ships. The cross-judge was skipped for that reason.

They split on one point, where "alike" comes from.

| | Per-slot swaps (runner 1) | `Lift.muscle` (this base) |
|---|---|---|
| Owner | The coach, per slot | The coach, per catalog lift |
| Helps Swap | Yes, for the slots it fills | Yes, for every slot |
| Helps Add exercise | No | Yes, through the day's muscles |
| Cost | Two to four swaps on each slot, and many What changed lines the week they land | 61 tags once, invisible in What changed |
| Schema | None | One optional loose field, strict only at publish |

This base wins because the tag serves both pickers and is one fact per lift. One graft comes from runner 1. The coach prompt also asks for two to four swaps per slot, closest first, and says that a lift he swapped to in a slot more than once belongs in that slot's `swaps`. The listed swaps stay the first tier.

## Tradeoffs accepted

- **No row before the first set.** We accept that an added exercise picked and abandoned leaves no row, in exchange for no stored "added" list and no second removal path. The typed digits survive in trainDraft under `a:<liftId>`, so re-adding loses nothing.
- **Coach-written tags.** We accept that the alike tier depends on the coach and is empty until the first publish after deploy. In exchange, similarity is a fact on the catalog row, kept by the one actor who already curates it, with no static library to drift from it.
- **A loose `muscle` slug.** We accept a vocabulary enforced only at publish, not in the stored type. In exchange, a value added later can never make an old build drop the whole program.
- **Legacy fields read in two places.** We accept that `notesOn` (phone) and `notesOf` (coach) both read `session.note` and `performance.note`. The representation is frozen, since nothing writes it again except to empty it, so the two can never need a coordinated change. A future reader might take this for leakage.
- **Accessible names change.** We accept renaming two picker lists, "Listed for this slot" to "Suggested" and "In the catalog" to "All lifts", because their contents changed and the old names would now be wrong. "Another lift", "New lift", `Use "…"` and the "Swap" dialog stay.
- **trainDraft key format.** We accept one dropped set of typed digits at upgrade, in exchange for keys that cannot collide between slots and added lifts.
- **Unbounded `first` tiers.** We accept that tiers 1 and 2 are uncapped. In practice they hold a handful, and cutting the plan's own choices would be wrong.

## Alternatives considered

- **Notes as an array on Session and Performance** (`notes?: { at, text }[]`). This lost on shared state. Each line is a read-modify-write of the session under whole-document sync, so lines from two phones offline drop one. An exercise note would still need a performance, so a set first, and deleting the last set would take its notes with it. Its interface looks smaller, but callers inherit the queue and the lost-write risk.
- **Changing `note` to `string | string[]`.** This was rejected outright. An old build fails to parse every session that holds an array.
- **A stored "added" list on the session**, so a row exists before its first set. This lost because it is a second source of truth for what he did, beside performances. It needs its own removal and undo, and it contradicts "nothing in it leaves no trace". It is a shallower model for little gain.
- **A built-in exercise library in code** with muscles and common names. This lost as a hand-synced list against the catalog. It cannot know the names he types, and it puts a second curator beside the coach.
- **Similarity from names** (shared words). This lost because "Leg press" and "Bench press" share a word and nothing else.
- **A strict `z.enum` for `muscle` in the stored schema.** This lost because it is the one shape where a later vocabulary change empties Train on an old build.
- **Two pickers, swap and add.** This lost because the sources, search and new-name rules are the same, and two copies would drift.
- **Keeping `Slot` and adding a synthetic slot for added exercises.** This lost because it fakes a `Target` and a `SlotId` the plan never had, and the coach would read invented prescriptions.

## Open questions and risks

- Is renaming the picker's list names to "Suggested" and "All lifts" acceptable, given the constraint to keep accessible names?
- Should a publish require `muscle` on every lift, which forces the backfill in one run, instead of the prompt asking for it? The design does not block publishing.
- Is the muscle vocabulary right for how he thinks, including `full-body` for sled work and no `adductors` or `neck`? Each addition is safe once stored values are loose.
- Should the Note sheet stay open after Save, with the field cleared and the new line appended, rather than closing with an undo toast? The design closes, which matches every other sheet.
- Should the day screen show anything of his own notes, for example a count on a row? The design shows nothing, to stay quiet.
- Risk: the first `pickerView` read scans 8 weeks of performances. That should be a few hundred docs, but it has not been measured on the phone.
- Risk: an old build still open on a second device can write `session.note` after this ships. It is read correctly, but it lists first with no time.

## Next implementation step

Land the `Exercise` refactor first, behavior-preserving: `isOn`, `exerciseLog`, and `SetPlace`, `withSet`, `SetCard` and `EditSetSheet` taking an exercise, with every existing vitest and e2e still green. Then add exercise, then the picker and `muscle`, then notes, each as its own verified commit.
