/**
 * One exercise, opened whenever he gets to it. What it shows comes from the day's stored sets, so
 * a reload or a lock has nothing to restore but typed digits, which wait in trainDraft. After a set
 * it stays here and fills in the next one.
 */
import { useState } from 'preact/hooks';
import type { Performance } from '../../domain/lifts.js';
import { slotIn, type PlannedDay, type ProgramNote, type Slot } from '../../domain/program.js';
import { cueFor, exerciseLog, isOn, type DayRef, type Exercise, type LiftChoice, type LoggedSet } from '../../domain/session.js';
import { afterLog, entryOf, typedFor, withSwap, withTyped, type SetForm, type TrainDraft } from '../trainDraft.js';
import { useIntents, type DayScreenView } from '../views.js';
import { CueSheet, EditSetSheet, NoteSheet, SkipSheet } from './ExerciseSheets.js';
import { targetNotes } from './format.js';
import { LiftPicker } from './LiftPicker.js';
import { CardAction, SetCard } from './SetCard.js';
import { BackButton, useToast } from './ui.js';
import { Waiting } from './Waiting.js';

/** What the Cue action opens: the words behind the numbers, rest among them as plain text. */
function cueLines(plan: PlannedDay, slot: Slot, lift: LiftChoice, notes: readonly ProgramNote[]): readonly string[] {
  const block = slotIn(plan, slot.id)?.block;
  const cue = cueFor(slot, lift.liftId);
  return [
    ...(block !== undefined && block.slots.length === 1 && block.title !== undefined && block.title !== slot.label ? [block.title] : []),
    ...(cue === undefined ? [] : [cue]),
    ...(block?.note === undefined ? [] : [block.note]),
    ...targetNotes(slot.target),
    ...(block?.restSeconds === undefined ? [] : [`Rest ${block.restSeconds}s`]),
    ...notes.map((note) => note.text),
  ];
}

/** Which sheet is over the exercise. Only editing needs to say more. */
type OpenSheet = { readonly kind: 'swap' | 'skip' | 'note' | 'cue' } | { readonly kind: 'edit'; readonly row: LoggedSet };

export function ExerciseScreen({
  view,
  day,
  exercise,
  rows,
  draft,
  onDraft,
  onBack,
}: {
  readonly view: DayScreenView;
  readonly day: DayRef;
  /** A slot with whatever he is doing in it now, which a swap may have changed, or a lift he added. */
  readonly exercise: Exercise;
  readonly rows: readonly Performance[];
  readonly draft: TrainDraft;
  readonly onDraft: (next: TrainDraft) => void;
  readonly onBack: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const closeSheet = () => setSheet(null);
  const { slot, lift } = exercise;
  const log = exerciseLog(exercise, view);
  const nextSet = log.done + 1;
  const cues = slot === null ? [] : cueLines(view.plan, slot, lift, view.notes);

  const logSet = (form: SetForm) => {
    void intents.logSet({ day, exercise }, entryOf(form)).then((undo) => {
      if (undo === null) return;
      onDraft(afterLog(draft, exercise));
      toast({ text: `${lift.label} logged`, undo });
    });
  };

  const note = <CardAction label="Note" onClick={() => setSheet({ kind: 'note' })} />;
  return (
    <>
      <section class="exercise" aria-label="Exercise">
        <header class="exercise-bar">
          <BackButton onBack={onBack} />
          <Waiting />
        </header>
        <SetCard
          exercise={exercise}
          day={day}
          rows={rows}
          book={view.book}
          performances={view.performances}
          log={log}
          typed={typedFor(draft, exercise, nextSet)}
          onForm={(form) => onDraft(withTyped(draft, exercise, nextSet, form))}
          onLog={logSet}
          onSwitch={(choice) => {
            if (slot !== null) onDraft(withSwap(draft, slot.id, choice));
          }}
          onEdit={(row) => setSheet({ kind: 'edit', row })}
          actions={
            slot === null ? (
              note
            ) : (
              <>
                <CardAction label="Swap" onClick={() => setSheet({ kind: 'swap' })} />
                <CardAction label="Skip" onClick={() => setSheet({ kind: 'skip' })} />
                {note}
                <CardAction label="Cue" disabled={cues.length === 0} onClick={() => setSheet({ kind: 'cue' })} />
              </>
            )
          }
        />
      </section>
      {sheet?.kind === 'swap' && slot !== null && (
        <LiftPicker
          title="Swap"
          pickFor={{ kind: 'swap', slot, current: lift.liftId }}
          day={day}
          lifts={view.lifts}
          book={view.book}
          onPick={(choice) => {
            onDraft(withSwap(draft, slot.id, choice));
            closeSheet();
          }}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'skip' && slot !== null && (
        <SkipSheet
          label={lift.label}
          onClose={closeSheet}
          onSkip={(skipNote) => {
            closeSheet();
            onBack();
            void intents.skipSlot(day, slot.id, skipNote).then((undo) => toast({ text: `Skipped ${lift.label}`, undo }));
          }}
        />
      )}
      {sheet?.kind === 'note' && <NoteSheet day={day} dayNote={view.session?.note} exercise={view.performances.find((p) => isOn(exercise, p) && p.liftId === lift.liftId)} onClose={closeSheet} />}
      {sheet?.kind === 'cue' && <CueSheet lines={cues} onClose={closeSheet} />}
      {sheet?.kind === 'edit' && <EditSetSheet logged={sheet.row} exercise={exercise} onClose={closeSheet} />}
    </>
  );
}
