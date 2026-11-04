/** The sheets over a running session: Plan, Swap, Skip, Note, Cue and editing a logged set. */
import { useLayoutEffect, useState } from 'preact/hooks';
import type { Lift, LiftId, Performance } from '../../domain/lifts.js';
import type { Block, DayPart, LiftsBlock, ProgramNote, Slot } from '../../domain/program.js';
import { blockDone, entryOfSet, setLogOf, slotLog, swapChoices, type LiftChoice, type LoggedSet, type Session, type SessionLogs } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { useIntents, type SessionPlan } from '../views.js';
import { planSections } from './format.js';
import { CardActions, SetInputs, WarmUpToggle, setRowText } from './SetCard.js';
import { NoteField, Segmented, Sheet, TextField, useToast } from './ui.js';

function Dots({ filled, total }: { readonly filled: number; readonly total: number }) {
  return (
    <span class="dots" role="img" aria-label={`${filled} of ${total} logged`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} class={i < filled ? 'filled' : undefined} />
      ))}
    </span>
  );
}

function PlanRow({ name, current, skipped = false, filled, total, onJump }: { readonly name: string; readonly current: boolean; readonly skipped?: boolean; readonly filled: number; readonly total: number; readonly onJump: () => void }) {
  return (
    <button type="button" class="row" aria-current={current ? 'step' : undefined} onClick={onJump}>
      <span class="row-name">{name}</span>
      <span class="row-end">
        {skipped && <span class="detail">Skipped</span>}
        <Dots filled={filled} total={total} />
      </span>
    </button>
  );
}

interface PlanActions {
  readonly logs: SessionLogs;
  /** The slot or block in focus. */
  readonly currentId: string | null;
  readonly onJumpSlot: (slot: Slot) => void;
  readonly onJumpBlock: (block: Block) => void;
  readonly onEdit: (row: LoggedSet, slot: Slot) => void;
}

function PlanPart({ part, logs, currentId, onJumpSlot, onJumpBlock, onEdit }: PlanActions & { readonly part: DayPart }) {
  const { block } = part;
  if (block.kind !== 'lifts') {
    return (
      <li>
        <PlanRow name={block.title ?? (block.kind === 'checklist' ? 'Checklist' : 'Cardio')} current={currentId === block.id} filled={blockDone(block, logs) ? 1 : 0} total={1} onJump={() => onJumpBlock(block)} />
      </li>
    );
  }
  return (
    <>
      {block.slots.map((slot) => {
        const log = slotLog(slot, logs);
        return (
          <li key={slot.id}>
            <PlanRow name={slot.label} current={currentId === slot.id} skipped={log.skipped} filled={log.rounds} total={log.dots} onJump={() => onJumpSlot(slot)} />
            {log.sets.map((row) => (
              <button type="button" class="plan-set" key={`${row.performance.id}#${row.index}`} onClick={() => onEdit(row, slot)}>
                {setRowText(row, slot)}
              </button>
            ))}
          </li>
        );
      })}
    </>
  );
}

function PlanLists({ parts, ...actions }: PlanActions & { readonly parts: readonly DayPart[] }) {
  return (
    <>
      {planSections(parts).map((section) => (
        <section class="plan-section" key={section.parts[0]?.block.id} aria-label={section.label ?? undefined}>
          {section.label !== null && <h3 class="section-heading">{section.label}</h3>}
          <ul class="list">
            {section.parts.map((part) => (
              <PlanPart key={part.block.id} part={part} {...actions} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The whole day: a tap on a row jumps to it, and a tap on a logged set edits it. */
export function PlanSheet({ plan, onClose, ...actions }: PlanActions & { readonly plan: SessionPlan; readonly onClose: () => void }) {
  // By hand, because scrollIntoView would also move the page under a sheet still sliding in.
  useLayoutEffect(() => {
    const row = document.querySelector('.sheet [aria-current="step"]');
    const body = row?.closest('.sheet-body');
    if (row === null || row === undefined || body === null || body === undefined) return;
    body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
  }, []);
  const required = plan.parts.filter((part) => part.block.optional !== true);
  const optional = plan.parts.filter((part) => part.block.optional === true);
  return (
    <Sheet title="Plan" onClose={onClose} closeLabel="Done">
      <PlanLists parts={required} {...actions} />
      {optional.length > 0 && (
        <>
          <h3 class="section-heading">Optional</h3>
          <PlanLists parts={optional} {...actions} />
        </>
      )}
    </Sheet>
  );
}

function ChoiceList({ title, choices, onPick }: { readonly title: string; readonly choices: readonly LiftChoice[]; readonly onPick: (choice: LiftChoice) => void }) {
  if (choices.length === 0) return null;
  return (
    <ul class="list" aria-label={title}>
      {choices.map((choice) => (
        <li key={choice.liftId}>
          <button type="button" class="row-button swap-choice" onClick={() => onPick(choice)}>
            {choice.label}
          </button>
        </li>
      ))}
    </ul>
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
      <NoteField label="Why (optional)" value={note} onInput={setNote} maxLength={1000} />
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
      <NoteField
        label={scope === 'exercise' ? `On ${exercise?.label ?? 'this exercise'}` : 'On the session'}
        labelClass={exercise === undefined ? 'field-label' : 'sr-only'}
        value={text}
        onInput={scope === 'exercise' ? setExerciseText : setSessionText}
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

export function CueSheet({ cue, block, notes, onClose }: { readonly cue: string | undefined; readonly block: LiftsBlock | undefined; readonly notes: readonly ProgramNote[]; readonly onClose: () => void }) {
  return (
    <Sheet title="Cue" onClose={onClose} closeLabel="Done">
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

/** A logged set, from its value on the focus screen or its row in the plan. Its tap stays, so the rest clock and the minutes hold. */
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
