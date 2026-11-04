/** One exercise in focus: what to do now up top, and in the thumb's reach, most sets being one tap on Log set. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LocalDate } from '../../domain/ids.js';
import { lastLineOf, lastTimeOf, lastSwapAt, typedLine } from '../../domain/progress.js';
import type { LiftBook, Performance, Target, Unit } from '../../domain/lifts.js';
import type { Slot, Step } from '../../domain/program.js';
import { isExtra, prefillSet, setLogOf, sideOrder, steppedLoad, steppedReps, type LiftChoice, type LoggedSet, type Side } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { editable, parseNumber, repsTargetText, shortDate } from './format.js';

const OTHER_UNIT: Readonly<Record<Unit, Unit>> = { lb: 'kg', kg: 'lb' };

/** How long Log set stays off after a tap, so a double tap on a wet hand cannot log the next set too. */
const DOUBLE_TAP_MS = 350;

/** On from the first render, because the tap that brought the card here may be the first of a double one. */
function useCooldown(): readonly [boolean, () => void] {
  const [cooling, setCooling] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cool = () => {
    setCooling(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCooling(false), DOUBLE_TAP_MS);
  };
  useEffect(() => {
    cool();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  return [cooling, cool];
}

function Stepper({
  label,
  value,
  inputMode,
  onInput,
  onStep,
}: {
  readonly label: string;
  readonly value: string;
  readonly inputMode: 'decimal' | 'numeric';
  readonly onInput: (value: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  const lower = label.toLowerCase();
  return (
    <div class="stepper">
      <button type="button" aria-label={`Less ${lower}`} onClick={() => onStep(-1)}>
        −
      </button>
      <input aria-label={label} inputMode={inputMode} autoComplete="off" value={value} onInput={(event) => onInput(event.currentTarget.value)} />
      <button type="button" aria-label={`More ${lower}`} onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}

export function WarmUpToggle({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <button type="button" class="text-button warm-toggle" aria-pressed={on} onClick={onToggle}>
      <span>Warm-up</span>
    </button>
  );
}

function UnitToggle({ unit, onChange }: { readonly unit: Unit; readonly onChange: (unit: Unit) => void }) {
  return (
    <button type="button" class="text-button unit-toggle" aria-label={`Unit ${unit}, switch to ${OTHER_UNIT[unit]}`} onClick={() => onChange(OTHER_UNIT[unit])}>
      {unit}
    </button>
  );
}

const stepsOfReps = (text: string, direction: 1 | -1) => editable(steppedReps(parseNumber(text), direction));

const SIDE_LABEL: Readonly<Record<Side, { readonly short: string; readonly long: string }>> = { left: { short: 'L', long: 'Left reps' }, right: { short: 'R', long: 'Right reps' } };

function RepsRows({ reps, perSide, onChange }: { readonly reps: SetForm['reps']; readonly perSide: Target['perSide']; readonly onChange: (reps: SetForm['reps']) => void }) {
  if (reps.kind === 'total') {
    return (
      <div class="set-row">
        <Stepper label="Reps" inputMode="numeric" value={reps.reps} onInput={(text) => onChange({ kind: 'total', reps: text })} onStep={(direction) => onChange({ kind: 'total', reps: stepsOfReps(reps.reps, direction) })} />
        <span class="set-row-unit">reps</span>
      </div>
    );
  }
  return (
    <>
      {sideOrder(perSide).map((side) => (
        <div class="set-row" key={side}>
          <Stepper label={SIDE_LABEL[side].long} inputMode="numeric" value={reps[side]} onInput={(text) => onChange({ ...reps, [side]: text })} onStep={(direction) => onChange({ ...reps, [side]: stepsOfReps(reps[side], direction) })} />
          <span class="set-row-unit side">{SIDE_LABEL[side].short}</span>
        </div>
      ))}
    </>
  );
}

function LoadRow({ form, onChange }: { readonly form: SetForm; readonly onChange: (form: SetForm) => void }) {
  const { load } = form;
  const addWeight = (
    <button type="button" class="text-button" onClick={() => onChange({ ...form, load: { kind: 'weight', amount: '', unit: 'lb' } })}>
      Add weight
    </button>
  );
  switch (load.kind) {
    case 'weight':
      return (
        <>
          <div class="set-row">
            <Stepper
              label="Load"
              inputMode="decimal"
              value={load.amount}
              onInput={(amount) => onChange({ ...form, load: { ...load, amount } })}
              onStep={(direction) => {
                const next = steppedLoad(parseNumber(load.amount), load.unit, direction);
                onChange({ ...form, load: { ...load, amount: next === null ? '' : editable(next) } });
              }}
            />
            <UnitToggle unit={load.unit} onChange={(unit) => onChange({ ...form, load: { ...load, unit } })} />
          </div>
          {load.amount === '' && (
            <div class="quiet-actions start">
              <button type="button" class="text-button" onClick={() => onChange({ ...form, load: { kind: 'bodyweight' } })}>
                Bodyweight
              </button>
              <button type="button" class="text-button" onClick={() => onChange({ ...form, load: { kind: 'band', label: '' } })}>
                Band
              </button>
            </div>
          )}
        </>
      );
    case 'band':
      return (
        <div class="set-row loose">
          <input class="band-input" aria-label="Band" placeholder="Which band" autoComplete="off" value={load.label} onInput={(event) => onChange({ ...form, load: { kind: 'band', label: event.currentTarget.value } })} />
          {addWeight}
        </div>
      );
    case 'bodyweight':
      return (
        <div class="set-row loose">
          <span class="set-row-text">Bodyweight</span>
          {addWeight}
        </div>
      );
  }
}

/** The load and reps of one set, in the focus screen and when editing a logged set. */
export function SetInputs({ form, onChange, perSide, prompt }: { readonly form: SetForm; readonly onChange: (form: SetForm) => void; readonly perSide: Target['perSide']; readonly prompt: string | undefined }) {
  return (
    <>
      <LoadRow form={form} onChange={onChange} />
      <RepsRows reps={form.reps} perSide={perSide} onChange={(reps) => onChange({ ...form, reps })} />
      {prompt !== undefined && (
        <label class="set-prompt">
          <span>{prompt}</span>
          <input autoComplete="off" maxLength={280} value={form.note} onInput={(event) => onChange({ ...form, note: event.currentTarget.value })} />
        </label>
      )}
    </>
  );
}

/** Swap, Skip, Note, Cue, Warm-up. */
export function CardActions({ children }: { readonly children: ComponentChildren }) {
  return <div class="quiet-actions">{children}</div>;
}

export function CardAction({ label, disabled = false, onClick }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void }) {
  return (
    <button type="button" class="text-button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

/** A logged set in words, for the plan's row and a screen reader. */
export function setRowText({ performance, set }: LoggedSet, slot: Slot): string {
  const lift = performance.liftId === slot.liftId ? '' : `${performance.label}, `;
  const note = set.note === undefined ? '' : `, ${set.note}`;
  return `${set.warmup === true ? 'Warm-up, ' : ''}${lift}${typedLine([set], '×')}${note}`;
}

/** Today's sets of the lift in focus, a tap from editing. */
function TodaySets({ sets, slot, onEdit }: { readonly sets: readonly LoggedSet[]; readonly slot: Slot; readonly onEdit: (row: LoggedSet) => void }) {
  if (sets.length === 0) return null;
  return (
    <div class="today-sets" role="group" aria-label="Today's sets">
      {sets.map((row) => (
        <button type="button" key={`${row.performance.id}#${row.index}`} aria-label={`Edit ${setRowText(row, slot)}`} onClick={() => onEdit(row)}>
          <span>
            {row.set.warmup === true && 'W '}
            {typedLine([row.set], '×')}
          </span>
        </button>
      ))}
    </div>
  );
}

function blurTyping() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Keeps a focused field clear of the keyboard's edge inside its own scroller. */
const revealField = (event: FocusEvent) => {
  if (event.target instanceof HTMLElement) event.target.scrollIntoView({ block: 'nearest' });
};

export function SetCard({
  step,
  lift,
  today,
  before,
  rows,
  book,
  performances,
  typed,
  logged,
  onForm,
  onLog,
  onSwitch,
  onEdit,
  actions,
}: {
  readonly step: Step;
  readonly lift: LiftChoice;
  readonly today: LocalDate;
  /** The session's date. Last-time reads stop before it. */
  readonly before: LocalDate;
  readonly rows: readonly Performance[];
  readonly book: LiftBook;
  /** This session's. */
  readonly performances: readonly Performance[];
  /** What he has typed for this very set, if anything. */
  readonly typed: SetForm | undefined;
  /** This slot's sets so far. */
  readonly logged: readonly LoggedSet[];
  readonly onForm: (form: SetForm) => void;
  readonly onLog: (form: SetForm) => void;
  readonly onSwitch: (choice: LiftChoice) => void;
  readonly onEdit: (row: LoggedSet) => void;
  readonly actions: ComponentChildren;
}) {
  const { slot, round } = step;
  const read = { lift: lift.liftId, rows, book, before };
  const last = lastTimeOf(read);
  const form = typed ?? formOf({ ...prefillSet({ lift: lift.liftId, book, target: slot.target, today: performances, last }), warmup: false, note: '' });
  const line = lastLineOf(read);
  const swapHint = lift.liftId === slot.liftId ? lastSwapAt({ ...read, lift: slot.liftId }) : undefined;
  const valid = setLogOf(entryOf(form)) !== null;
  const [cooling, cool] = useCooldown();

  const log = () => {
    if (!valid) return;
    blurTyping();
    cool();
    onLog(form);
  };

  return (
    <section class="set-card" aria-label="Set">
      <div class="focus">
        <h2>{lift.label}</h2>
        <p class="focus-line">
          <span class="focus-round" data-testid="round">
            {isExtra(step) ? 'Extra set' : `Set ${round} of ${slot.target.sets}`}
          </span>
          {` · ${repsTargetText(slot.target)}`}
        </p>
        {line !== null && (
          <p class="focus-line">
            {`Last ${line.line} · ${shortDate(line.date, today)}`}
            {line.addWeight && <span class="mark-good"> Add weight</span>}
          </p>
        )}
        {swapHint !== undefined && (
          <p class="focus-line focus-swap">
            Last time: {swapHint.label}
            <button type="button" class="text-button" onClick={() => onSwitch({ liftId: swapHint.liftId, label: swapHint.label })}>
              Switch
            </button>
          </p>
        )}
        <TodaySets sets={logged} slot={slot} onEdit={onEdit} />
      </div>
      <div class="set-controls">
        <div class="set-inputs" onFocusIn={revealField}>
          <SetInputs form={form} onChange={onForm} perSide={slot.target.perSide} prompt={slot.setPrompt} />
        </div>
        <button type="button" class={valid && cooling ? 'primary log-set cooling' : 'primary log-set'} disabled={!valid || cooling} onClick={log}>
          Log set
        </button>
        <CardActions>
          {actions}
          <WarmUpToggle on={form.warmup} onToggle={() => onForm({ ...form, warmup: !form.warmup })} />
        </CardActions>
      </div>
    </section>
  );
}
