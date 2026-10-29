import { useState } from 'preact/hooks';
import { ACTIVITY_GROUPS, MET_ACTIVITIES, MET_ACTIVITY_IDS, Workout, WorkoutDraft, metDraft, netKcal, type WorkoutSource } from '../../domain/burn.js';
import type { BudgetPolicy } from '../../domain/goals.js';
import type { LocalDate } from '../../domain/ids.js';
import { useIntents, useLive, workoutLoggerView } from '../views.js';
import { amount, editable, kcal, lb, parseNumber } from './format.js';
import { Icon, NumberField, Sheet, TextField, useToast } from './ui.js';

const MINUTES = [15, 30, 45, 60, 90] as const;

/** What the details step is for: a built-in activity or a burn Dylan types in. */
type Choice = { readonly kind: 'met'; readonly activity: string; readonly name: string; readonly met: number } | { readonly kind: 'custom' };

function choiceOf(draft: WorkoutDraft): Choice {
  return draft.source.kind === 'met' ? { kind: 'met', activity: draft.source.activity, name: draft.name, met: draft.source.met } : { kind: 'custom' };
}

const minutesLabel = (minutes: number) => `${amount(minutes)} min`;

function Picker({
  recents,
  kg,
  onPick,
}: {
  readonly recents: readonly WorkoutDraft[];
  readonly kg: number | undefined;
  readonly onPick: (choice: Choice, from?: WorkoutDraft) => void;
}) {
  return (
    <>
      <div class="group">
        <button type="button" class="row-button" onClick={() => onPick({ kind: 'custom' })}>
          <Icon name="plus" /> Custom workout
        </button>
      </div>
      {recents.length > 0 && (
        <>
          <h4 class="group-title">Recent</h4>
          <ul class="list" aria-label="Recent workouts">
            {recents.map((draft) => (
              <li key={`${draft.name}-${draft.minutes}`}>
                <button type="button" class="entry-row" onClick={() => onPick(choiceOf(draft), draft)}>
                  <span class="food-name">{draft.name}</span>
                  <span class="food-detail">{minutesLabel(draft.minutes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {ACTIVITY_GROUPS.map((group) => (
        <section key={group} aria-label={group}>
          <h4 class="group-title">{group}</h4>
          <ul class="list">
            {MET_ACTIVITY_IDS.filter((id) => MET_ACTIVITIES[id].group === group).map((id) => {
              const { label, met } = MET_ACTIVITIES[id];
              const perHalfHour = kg === undefined ? '' : ` · ${kcal(netKcal(metDraft(id, 30), kg))} kcal per 30 min`;
              return (
                <li key={id}>
                  <button type="button" class="entry-row" onClick={() => onPick({ kind: 'met', activity: id, name: label, met })}>
                    <span class="food-name">{label}</span>
                    <span class="food-detail">
                      {amount(met)} MET{perHalfHour}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

function sourceOf(choice: Choice, grossKcal: number | null): WorkoutSource | null {
  switch (choice.kind) {
    case 'met':
      return { kind: 'met', activity: choice.activity, met: choice.met };
    case 'custom':
      return grossKcal === null ? null : { kind: 'custom', grossKcal };
  }
}

/** Logs a workout, or edits one: pick an activity, set the minutes, see the burn above resting. */
export function WorkoutSheet({ date, editing, onClose }: { readonly date: LocalDate; readonly editing?: Workout; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const view = useLive((r) => workoutLoggerView(r, date), [date]);
  const [choice, setChoice] = useState<Choice | null>(editing === undefined ? null : choiceOf(editing));
  const [minutesText, setMinutesText] = useState(editing === undefined ? '30' : editable(editing.minutes));
  const [nameText, setNameText] = useState(editing?.source.kind === 'custom' ? editing.name : '');
  const [kcalText, setKcalText] = useState(editing?.source.kind === 'custom' ? editable(editing.source.grossKcal) : '');
  const title = editing === undefined ? 'Add workout' : 'Edit workout';
  if (view === undefined) return null;

  if (choice === null) {
    return (
      <Sheet title={title} onClose={onClose}>
        <Picker
          recents={view.recents}
          kg={editing?.kg ?? view.weight?.kg}
          onPick={(picked, from) => {
            setChoice(picked);
            if (from !== undefined) setMinutesText(editable(from.minutes));
            if (from?.source.kind === 'custom') {
              setNameText(from.name);
              setKcalText(editable(from.source.grossKcal));
            }
          }}
        />
      </Sheet>
    );
  }

  const kg = editing?.kg ?? view.weight?.kg;
  const source = sourceOf(choice, parseNumber(kcalText));
  const parsed = WorkoutDraft.safeParse({ name: choice.kind === 'met' ? choice.name : nameText.trim(), minutes: parseNumber(minutesText), source });
  const draft = parsed.success ? parsed.data : null;
  const burn = draft === null || kg === undefined ? null : Math.round(netKcal(draft, kg));
  /** The replica refuses a burn the workout schema would not store, so Log stays off and says why before the tap. */
  const storable = burn !== null && Workout.shape.kcal.safeParse(burn).success;

  const save = () => {
    if (draft === null || !storable) return;
    onClose();
    if (editing === undefined) {
      void intents.logWorkout(draft, date).then((undo) => {
        if (undo !== null) toast({ text: `Logged ${draft.name}`, undo });
      });
    } else {
      void intents.editWorkout(editing.id, draft).then((undo) => toast({ text: `Updated ${draft.name}`, undo }));
    }
  };

  return (
    <Sheet title={title} onClose={onClose}>
      <div class="group">
        {choice.kind === 'met' ? (
          <div class="field">
            <span class="field-label workout-name">{choice.name}</span>
            <button type="button" class="text-button" onClick={() => setChoice(null)}>
              Change
            </button>
          </div>
        ) : (
          <TextField label="Name" value={nameText} onInput={setNameText} placeholder="Spin class" />
        )}
        <NumberField label="Duration" unit="min" value={minutesText} onInput={setMinutesText} invalid={parseNumber(minutesText) === null || (parseNumber(minutesText) ?? 0) <= 0} />
        {choice.kind === 'custom' && <NumberField label="Calories burned" unit="kcal" value={kcalText} onInput={setKcalText} placeholder="400" />}
      </div>
      <div class="pills minutes">
        {MINUTES.map((m) => (
          <button type="button" class="pill" key={m} aria-pressed={parseNumber(minutesText) === m} onClick={() => setMinutesText(String(m))}>
            {m} min
          </button>
        ))}
      </div>
      {choice.kind === 'custom' && <p class="hint">Enter the burn as a machine or app reports it. Your resting burn for the time is taken off, since your target already counts it.</p>}
      <div class="card burn-preview">
        <p class="summary-label">Burned above resting</p>
        <p class="summary-big">
          <strong data-testid="workout-kcal">{burn === null ? '–' : kcal(burn)}</strong> kcal
        </p>
        <p class="target-detail">
          {kg === undefined ? 'Weigh in or add your details on the Goal screen to work out the burn.' : `Worked out at ${lb(kg)} lb${editing === undefined ? '' : ', your weight when you logged it'}.`}
        </p>
      </div>
      {burn !== null && !storable && <p class="hint warn">That is more than one workout can burn. Check the minutes.</p>}
      <div class="sheet-actions">
        <button type="button" class="primary" disabled={!storable} onClick={save}>
          {editing === undefined ? 'Log workout' : 'Save workout'}
        </button>
        {editing !== undefined && (
          <button
            type="button"
            class="destructive"
            onClick={() => {
              onClose();
              void intents.deleteWorkout(editing.id).then((undo) => toast({ text: `Deleted ${editing.name}`, undo }));
            }}
          >
            Delete workout
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** The day's workouts in the diary, under the meals, with what they do to the target. */
export function WorkoutsSection({ date, workouts, policy }: { readonly date: LocalDate; readonly workouts: readonly Workout[]; readonly policy: BudgetPolicy | undefined }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Workout | null>(null);
  const burned = workouts.reduce((sum, w) => sum + w.kcal, 0);

  return (
    <section class="meal" aria-label="Workouts">
      <header class="meal-header">
        <h2>Workouts</h2>
        {workouts.length > 0 && <span class="meal-kcal">{kcal(burned)} kcal</span>}
      </header>
      <ul class="list">
        {workouts.map((workout) => (
          <li key={workout.id}>
            <button type="button" class="entry-row" onClick={() => setEditing(workout)}>
              <span class="food-name">{workout.name}</span>
              <span class="food-detail">{minutesLabel(workout.minutes)}</span>
              <span class="entry-kcal">{kcal(workout.kcal)}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" class="row-button" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add workout
          </button>
        </li>
      </ul>
      {workouts.length > 0 && policy?.kind === 'activity-level' && <p class="hint">Not added to your target. Your activity level already counts your exercise.</p>}
      {adding && <WorkoutSheet date={date} onClose={() => setAdding(false)} />}
      {editing !== null && <WorkoutSheet date={date} editing={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
