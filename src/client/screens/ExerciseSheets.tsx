/** The sheets over an exercise: Skip, Note, Cue and editing a logged set. Swap is the lift picker. */
import { useState } from 'preact/hooks';
import type { Performance } from '../../domain/lifts.js';
import { entryOfSet, setLogOf, type DayRef, type Exercise, type LoggedSet } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { useIntents } from '../views.js';
import { CardActions, SetInputs, WarmUpToggle } from './SetCard.js';
import { NoteField, Segmented, Sheet, useToast } from './ui.js';

export function SkipSheet({ label, onSkip, onClose }: { readonly label: string; readonly onSkip: (note: string) => void; readonly onClose: () => void }) {
  const [note, setNote] = useState('');
  return (
    <Sheet title={`Skip ${label}`} onClose={onClose}>
      <NoteField label="Why (optional)" value={note} onInput={setNote} maxLength={1000} />
      <div class="sheet-actions">
        <button type="button" class="primary" onClick={() => onSkip(note)}>
          Skip it
        </button>
      </div>
    </Sheet>
  );
}

type NoteScope = 'exercise' | 'day';

/** On the exercise once it has a set, since a performance is the proof of one, and always on the day. */
export function NoteSheet({ day, dayNote, exercise, onClose }: { readonly day: DayRef; readonly dayNote: string | undefined; readonly exercise: Performance | undefined; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [scope, setScope] = useState<NoteScope>(exercise === undefined ? 'day' : 'exercise');
  const [exerciseText, setExerciseText] = useState(exercise?.note ?? '');
  const [dayText, setDayText] = useState(dayNote ?? '');
  const text = scope === 'exercise' ? exerciseText : dayText;
  const save = () => {
    onClose();
    const write = scope === 'exercise' && exercise !== undefined ? intents.noteExercise(exercise.id, exerciseText) : intents.noteSession(day, dayText);
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
            { value: 'day', label: 'Today' },
          ]}
        />
      )}
      <NoteField
        label={scope === 'exercise' ? `On ${exercise?.label ?? 'this exercise'}` : "Today's note"}
        labelClass={exercise === undefined ? 'field-label' : 'sr-only'}
        value={text}
        onInput={scope === 'exercise' ? setExerciseText : setDayText}
        maxLength={scope === 'exercise' ? 1000 : 2000}
      />
      <div class="sheet-actions">
        <button type="button" class="primary" onClick={save}>
          Save note
        </button>
      </div>
    </Sheet>
  );
}

export function CueSheet({ lines, onClose }: { readonly lines: readonly string[]; readonly onClose: () => void }) {
  return (
    <Sheet title="Cue" onClose={onClose} closeLabel="Done">
      {lines.map((line, i) => (
        <p class="cue-text" key={i}>
          {line}
        </p>
      ))}
    </Sheet>
  );
}

/** A logged set, from its value on the exercise. Its tap stays, so the minutes hold. */
export function EditSetSheet({ logged, exercise: { slot }, onClose }: { readonly logged: LoggedSet; readonly exercise: Exercise; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [form, setForm] = useState<SetForm>(() => formOf(entryOfSet(logged.set)));
  const ref = { performanceId: logged.performance.id, index: logged.index };
  const entry = entryOf(form);
  const valid = setLogOf(entry) !== null;
  return (
    <Sheet title={`Edit ${logged.performance.label}`} onClose={onClose}>
      <div class="edit-set">
        <SetInputs form={form} onChange={setForm} perSide={slot?.target.perSide} prompt={slot?.setPrompt ?? (logged.set.note === undefined ? undefined : 'Note')} />
        <CardActions>
          <WarmUpToggle on={form.warmup} onToggle={() => setForm({ ...form, warmup: !form.warmup })} />
        </CardActions>
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
