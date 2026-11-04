/** The card in the thumb's reach: what to do now, and most sets are one tap on Log set. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LocalDate } from '../../domain/ids.js';
import { lastLineOf, lastTimeOf, lastSwapAt } from '../../domain/progress.js';
import type { LiftBook, Performance, Target, Unit } from '../../domain/lifts.js';
import { roundsOf, type Step } from '../../domain/program.js';
import { isExtra, prefillSet, setLogOf, sideOrder, steppedLoad, steppedReps, type LiftChoice, type Side } from '../../domain/session.js';
import { entryOf, formOf, type SetForm } from '../trainDraft.js';
import { editable, parseNumber, repsTargetText, shortDate } from './format.js';
import { Segmented } from './ui.js';

const UNITS: readonly { readonly value: Unit; readonly label: string }[] = [
  { value: 'lb', label: 'lb' },
  { value: 'kg', label: 'kg' },
];

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

function WarmUpToggle({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <button type="button" class="warm-toggle" aria-label="Warm-up" aria-pressed={on} onClick={onToggle}>
      W
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
  const toggle = <WarmUpToggle on={form.warmup} onToggle={() => onChange({ ...form, warmup: !form.warmup })} />;
  const addWeight = (
    <button type="button" class="text-button set-row-link" onClick={() => onChange({ ...form, load: { kind: 'weight', amount: '', unit: 'lb' } })}>
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
            <div class="set-row-end">
              <Segmented label="Unit" options={UNITS} value={load.unit} onChange={(unit) => onChange({ ...form, load: { ...load, unit } })} />
              {toggle}
            </div>
          </div>
          {load.amount === '' && (
            <div class="load-kinds">
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
        <div class="set-row">
          <input class="band-input" aria-label="Band" placeholder="Which band" autoComplete="off" value={load.label} onInput={(event) => onChange({ ...form, load: { kind: 'band', label: event.currentTarget.value } })} />
          <div class="set-row-end">
            {addWeight}
            {toggle}
          </div>
        </div>
      );
    case 'bodyweight':
      return (
        <div class="set-row">
          <span class="set-row-text">Bodyweight</span>
          <div class="set-row-end">
            {addWeight}
            {toggle}
          </div>
        </div>
      );
  }
}

/** The load and reps of one set, on the card and when editing a logged set. */
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

/** Swap, Skip, Note, Cues. */
export function CardActions({ children }: { readonly children: ComponentChildren }) {
  return <div class="set-actions">{children}</div>;
}

export function CardAction({ label, disabled = false, onClick }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void }) {
  return (
    <button type="button" class="text-button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

function blurTyping() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Keeps a focused field clear of the keyboard's edge inside the card's own scroller. */
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
  onForm,
  onLog,
  onSwitch,
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
  readonly onForm: (form: SetForm) => void;
  readonly onLog: (form: SetForm) => void;
  readonly onSwitch: (choice: LiftChoice) => void;
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
      <div class="set-card-body" onFocusIn={revealField}>
        <header class="set-card-head">
          <h2>{lift.label}</h2>
          <span class="set-card-round" data-testid="round">
            {isExtra(step) ? 'Extra set' : `Round ${round} of ${roundsOf(step.block)}`}
          </span>
        </header>
        <p class="set-card-line">
          {repsTargetText(slot.target)}.{line !== null && ` Last, ${shortDate(line.date, today)}: ${line.line}`}
          {line?.addWeight === true && <span class="exercise-add"> Add weight</span>}
        </p>
        {swapHint !== undefined && (
          <p class="set-card-line">
            Last time here you did {swapHint.label}.{' '}
            <button type="button" class="text-button inline" onClick={() => onSwitch({ liftId: swapHint.liftId, label: swapHint.label })}>
              Switch
            </button>
          </p>
        )}
        <SetInputs form={form} onChange={onForm} perSide={slot.target.perSide} prompt={slot.setPrompt} />
      </div>
      <button type="button" class="primary log-set" disabled={!valid || cooling} onClick={log}>
        Log set
      </button>
      {actions}
    </section>
  );
}
