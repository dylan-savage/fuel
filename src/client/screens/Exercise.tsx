/**
 * One exercise, opened whenever he gets to it. What it shows comes from the day's stored sets, so
 * a reload or a lock has nothing to restore but typed digits, which wait in trainDraft. After a set
 * it stays here and fills in the next one.
 */
import { useState } from 'preact/hooks';
import type { Performance } from '../../domain/lifts.js';
import type { LiftsBlock, ProgramNote, Slot } from '../../domain/program.js';
import { cueFor, slotLog, type DayRef, type LiftChoice, type LoggedSet } from '../../domain/session.js';
import { afterLog, entryOf, typedFor, withSwap, withTyped, type SetForm, type TrainDraft } from '../trainDraft.js';
import { useIntents, type DayScreenView } from '../views.js';
import { CueSheet, EditSetSheet, NoteSheet, SkipSheet, SwapSheet } from './ExerciseSheets.js';
import { targetNotes } from './format.js';
import { CardAction, SetCard } from './SetCard.js';
import { BackButton, useToast } from './ui.js';
import { Waiting } from './Waiting.js';

/** What the Cue action opens: the words behind the numbers, rest among them as plain text. */
function cueLines(block: LiftsBlock, slot: Slot, lift: LiftChoice, notes: readonly ProgramNote[]): readonly string[] {
  const cue = cueFor(slot, lift.liftId);
  return [
    ...(block.slots.length === 1 && block.title !== undefined && block.title !== slot.label ? [block.title] : []),
    ...(cue === undefined ? [] : [cue]),
    ...(block.note === undefined ? [] : [block.note]),
    ...targetNotes(slot.target),
    ...(block.restSeconds === undefined ? [] : [`Rest ${block.restSeconds}s`]),
    ...notes.map((note) => note.text),
  ];
}

/** Which sheet is over the exercise. Only editing needs to say more. */
type OpenSheet = { readonly kind: 'swap' | 'skip' | 'note' | 'cue' } | { readonly kind: 'edit'; readonly row: LoggedSet };

export function ExerciseScreen({
  view,
  day,
  block,
  slot,
  lift,
  rows,
  draft,
  onDraft,
  onBack,
}: {
  readonly view: DayScreenView;
  readonly day: DayRef;
  readonly block: LiftsBlock;
  readonly slot: Slot;
  /** Whatever he is doing in this slot now, which a swap may have changed. */
  readonly lift: LiftChoice;
  readonly rows: readonly Performance[];
  readonly draft: TrainDraft;
  readonly onDraft: (next: TrainDraft) => void;
  readonly onBack: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const closeSheet = () => setSheet(null);
  const log = slotLog(slot, view);
  const nextSet = log.done + 1;
  const cues = cueLines(block, slot, lift, view.notes);

  const logSet = (form: SetForm) => {
    void intents.logSet({ day, slot, lift }, entryOf(form)).then((undo) => {
      if (undo === null) return;
      onDraft(afterLog(draft, slot.id));
      toast({ text: `${lift.label} logged`, undo });
    });
  };

  return (
    <>
      <section class="exercise" aria-label="Exercise">
        <header class="exercise-bar">
          <BackButton onBack={onBack} />
          <Waiting />
        </header>
        <SetCard
          slot={slot}
          lift={lift}
          day={day}
          rows={rows}
          book={view.book}
          performances={view.performances}
          log={log}
          typed={typedFor(draft, slot.id, lift, nextSet)}
          onForm={(form) => onDraft(withTyped(draft, slot.id, lift, nextSet, form))}
          onLog={logSet}
          onSwitch={(choice) => onDraft(withSwap(draft, slot.id, choice))}
          onEdit={(row) => setSheet({ kind: 'edit', row })}
          actions={
            <>
              <CardAction label="Swap" onClick={() => setSheet({ kind: 'swap' })} />
              <CardAction label="Skip" onClick={() => setSheet({ kind: 'skip' })} />
              <CardAction label="Note" onClick={() => setSheet({ kind: 'note' })} />
              <CardAction label="Cue" disabled={cues.length === 0} onClick={() => setSheet({ kind: 'cue' })} />
            </>
          }
        />
      </section>
      {sheet?.kind === 'swap' && (
        <SwapSheet
          slot={slot}
          lifts={view.lifts}
          current={lift.liftId}
          onClose={closeSheet}
          onPick={(choice) => {
            onDraft(withSwap(draft, slot.id, choice));
            closeSheet();
          }}
        />
      )}
      {sheet?.kind === 'skip' && (
        <SkipSheet
          label={lift.label}
          onClose={closeSheet}
          onSkip={(note) => {
            closeSheet();
            onBack();
            void intents.skipSlot(day, slot.id, note).then((undo) => toast({ text: `Skipped ${lift.label}`, undo }));
          }}
        />
      )}
      {sheet?.kind === 'note' && <NoteSheet day={day} dayNote={view.session?.note} exercise={view.performances.find((p) => p.slotId === slot.id && p.liftId === lift.liftId)} onClose={closeSheet} />}
      {sheet?.kind === 'cue' && <CueSheet lines={cues} onClose={closeSheet} />}
      {sheet?.kind === 'edit' && <EditSetSheet logged={sheet.row} slot={slot} onClose={closeSheet} />}
    </>
  );
}
