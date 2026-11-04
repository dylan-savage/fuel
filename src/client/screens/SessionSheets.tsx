/** The sheets over a running session: Swap, Skip, Note, Cues and editing a logged set. */
import { useState } from 'preact/hooks';
import type { Lift, LiftId, Performance } from '../../domain/lifts.js';
import type { LiftsBlock, ProgramNote, Slot } from '../../domain/program.js';
import { entryOfSet, setLogOf, swapChoices, type LiftChoice, type LoggedSet, type Session } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { useIntents } from '../views.js';
import { SetInputs } from './SetCard.js';
import { NoteField, Segmented, Sheet, TextField, useToast } from './ui.js';

function ChoiceList({ title, choices, onPick }: { readonly title: string; readonly choices: readonly LiftChoice[]; readonly onPick: (choice: LiftChoice) => void }) {
  if (choices.length === 0) return null;
  return (
    <>
      <h4 class="section-heading">{title}</h4>
      <ul class="list" aria-label={title}>
        {choices.map((choice) => (
          <li key={choice.liftId}>
            <button type="button" class="row-button swap-choice" onClick={() => onPick(choice)}>
              {choice.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The slot's listed swaps first, then the catalog by search, then the search itself as a new lift. */
export function SwapSheet({
  slot,
  lifts,
  current,
  onPick,
  onClose,
}: {
  readonly slot: Slot;
  readonly lifts: readonly Lift[];
  readonly current: LiftId;
  readonly onPick: (choice: LiftChoice) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const { listed, catalog, typed } = swapChoices({ slot, lifts, current, query });
  return (
    <Sheet title="Swap" onClose={onClose}>
      <ChoiceList title="Listed for this slot" choices={listed} onPick={onPick} />
      <div class="group swap-search">
        <TextField label="Another lift" value={query} onInput={setQuery} placeholder="Search or type a name" />
      </div>
      <ChoiceList title="In the catalog" choices={catalog} onPick={onPick} />
      {typed !== null && (
        <ul class="list" aria-label="New lift">
          <li>
            <button type="button" class="row-button swap-choice" onClick={() => onPick(typed)}>
              Use "{typed.label}"
            </button>
          </li>
        </ul>
      )}
    </Sheet>
  );
}

export function SkipSheet({ label, onSkip, onClose }: { readonly label: string; readonly onSkip: (note: string) => void; readonly onClose: () => void }) {
  const [note, setNote] = useState('');
  return (
    <Sheet title={`Skip ${label}`} onClose={onClose}>
      <NoteField label="Why, if you want to say" value={note} onInput={setNote} maxLength={1000} />
      <div class="sheet-actions">
        <button type="button" class="primary" onClick={() => onSkip(note)}>
          Skip it
        </button>
      </div>
    </Sheet>
  );
}

type NoteScope = 'exercise' | 'session';

/** On the exercise once it has a set, since a performance is the proof of one, and always on the session. */
export function NoteSheet({ session, exercise, onClose }: { readonly session: Session; readonly exercise: Performance | undefined; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [scope, setScope] = useState<NoteScope>(exercise === undefined ? 'session' : 'exercise');
  const [exerciseText, setExerciseText] = useState(exercise?.note ?? '');
  const [sessionText, setSessionText] = useState(session.note ?? '');
  const text = scope === 'exercise' ? exerciseText : sessionText;
  const save = () => {
    onClose();
    const write = scope === 'exercise' && exercise !== undefined ? intents.noteExercise(exercise.id, exerciseText) : intents.noteSession(session.id, sessionText);
    void write.then((undo) => toast({ text: 'Note saved', undo }));
  };
  return (
    <Sheet title="Note" onClose={onClose}>
      {exercise !== undefined && (
        <Segmented
          label="Note on"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'exercise', label: 'This exercise' },
            { value: 'session', label: 'The session' },
          ]}
        />
      )}
      <NoteField label={scope === 'exercise' ? `On ${exercise?.label ?? 'this exercise'}` : 'On the session'} value={text} onInput={scope === 'exercise' ? setExerciseText : setSessionText} maxLength={scope === 'exercise' ? 1000 : 2000} />
      {exercise === undefined && <p class="hint">A note can sit on an exercise once it has a set.</p>}
      <div class="sheet-actions">
        <button type="button" class="primary" onClick={save}>
          Save note
        </button>
      </div>
    </Sheet>
  );
}

export function CuesSheet({ cue, block, notes, onClose }: { readonly cue: string | undefined; readonly block: LiftsBlock | undefined; readonly notes: readonly ProgramNote[]; readonly onClose: () => void }) {
  return (
    <Sheet title="Cues" onClose={onClose} closeLabel="Done">
      {cue !== undefined && <p class="cue-text">{cue}</p>}
      {block?.note !== undefined && <p class="cue-text">{block.note}</p>}
      {notes.map((note, i) => (
        <p class="cue-text" key={i}>
          {note.text}
        </p>
      ))}
    </Sheet>
  );
}

/** A logged set from its row in the plan. Its tap stays, so the rest clock and the minutes hold. */
export function EditSetSheet({ logged, slot, onClose }: { readonly logged: LoggedSet; readonly slot: Slot; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [form, setForm] = useState<SetForm>(() => formOf(entryOfSet(logged.set)));
  const ref = { performanceId: logged.performance.id, index: logged.index };
  const entry = entryOf(form);
  const valid = setLogOf(entry) !== null;
  return (
    <Sheet title={`Edit ${logged.performance.label}`} onClose={onClose}>
      <div class="edit-set">
        <SetInputs form={form} onChange={setForm} perSide={slot.target.perSide} prompt={slot.setPrompt ?? (logged.set.note === undefined ? undefined : 'Note')} />
      </div>
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={!valid}
          onClick={() => {
            onClose();
            void intents.editSet(ref, entry).then((undo) => toast({ text: 'Set updated', undo }));
          }}
        >
          Save set
        </button>
        <button
          type="button"
          class="destructive"
          onClick={() => {
            onClose();
            void intents.editSet(ref, null).then((undo) => toast({ text: 'Set deleted', undo }));
          }}
        >
          Delete set
        </button>
      </div>
    </Sheet>
  );
}
