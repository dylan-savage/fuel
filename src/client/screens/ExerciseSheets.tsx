/** The sheets over an exercise: Skip, Note, Cue and editing a logged set. Swap is the lift picker. */
import { useState } from 'preact/hooks';
import { notesOn, type DayNoteTarget, type NoteLine, type NoteRef } from '../../domain/notes.js';
import { entryOfSet, setLogOf, type DayRef, type Exercise, type LoggedSet } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { useIntents, type DayScreenView } from '../views.js';
import { CardActions, SetInputs, WarmUpToggle } from './SetCard.js';
import { NoteField, Row, Segmented, Sheet, useToast } from './ui.js';

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

const refKey = ({ kind, id }: NoteRef) => `${kind}:${id}`;

/** That scope's earlier lines, oldest first, over a fresh field, so a second note never lands on the first. A tap on a line edits it, as Edit set does a set. */
export function NoteSheet({ view, day, exercise, onClose }: { readonly view: DayScreenView; readonly day: DayRef; readonly exercise: Exercise; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [scope, setScope] = useState<NoteScope>('exercise');
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
  return (
    <Sheet title={editing === null ? 'Note' : 'Edit note'} onClose={onClose}>
      {editing === null && (
        <>
          <Segmented
            label="Note on"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'exercise', label: 'This exercise' },
              { value: 'day', label: 'Today' },
            ]}
          />
          {lines.length > 0 && (
            <ul class="list note-lines" aria-label="Earlier notes">
              {lines.map((line) => (
                <li key={refKey(line.ref)}>
                  <Row
                    name={line.text}
                    onClick={() => {
                      setEditing(line);
                      setText(line.text);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <NoteField label={scope === 'exercise' ? `On ${exercise.lift.label}` : "Today's note"} labelClass="sr-only" value={text} onInput={setText} maxLength={2000} />
      <div class="sheet-actions">
        <button type="button" class="primary" disabled={text.trim() === ''} onClick={save}>
          Save note
        </button>
        {editing !== null && (
          <button type="button" class="destructive" onClick={() => remove(editing)}>
            Delete note
          </button>
        )}
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
