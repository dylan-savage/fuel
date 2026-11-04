import { useState } from 'preact/hooks';
import { ACTIVITY_GROUPS, MET_ACTIVITIES, MET_ACTIVITY_IDS, Workout, WorkoutDraft, metDraft, netKcal, type WorkoutSource } from '../../domain/burn.js';
import type { DayRef } from '../../domain/session.js';
import type { LocalDate } from '../../domain/ids.js';
import { useIntents, useLive, workoutLoggerView } from '../views.js';
import { amount, editable, kcal, lb, parseNumber } from './format.js';
import { DaySection, Icon, NumberField, Row, Sheet, TextField, useToast } from './ui.js';

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
          <h4 class="section-heading">Recent</h4>
          <ul class="list" aria-label="Recent workouts">
            {recents.map((draft) => (
              <li key={`${draft.name}-${draft.minutes}`}>
                <Row name={draft.name} end={minutesLabel(draft.minutes)} onClick={() => onPick(choiceOf(draft), draft)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {ACTIVITY_GROUPS.map((group, i) => (
        <section key={group} aria-label={group}>
          <h4 class="section-heading heading-with-unit">
            {group}
            {i === 0 && kg !== undefined && <span class="detail">kcal per 30 min</span>}
          </h4>
          <ul class="list">
            {MET_ACTIVITY_IDS.filter((id) => MET_ACTIVITIES[id].group === group).map((id) => {
              const { label, met } = MET_ACTIVITIES[id];
              return (
                <li key={id}>
                  <Row name={label} {...(kg === undefined ? {} : { end: kcal(netKcal(metDraft(id, 30), kg)) })} onClick={() => onPick({ kind: 'met', activity: id, name: label, met })} />
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
export function WorkoutSheet({ date, day, editing, lead, onClose }: { readonly date: LocalDate; readonly day?: DayRef; readonly editing?: Workout; /** Words from the plan above the choices. */ readonly lead?: string | undefined; readonly onClose: () => void }) {
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
        {lead !== undefined && <p class="detail sheet-lead">{lead}</p>}
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
  const storable = burn !== null && Workout.shape.kcal.safeParse(burn).success;

  const save = () => {
    if (draft === null || !storable) return;
    onClose();
    if (editing === undefined) {
      void (day === undefined ? intents.logWorkout(draft, date) : intents.logDayCardio(day, draft)).then((undo) => {
        if (undo !== null) toast({ text: `Logged ${draft.name}`, undo });
      });
    } else {
      void intents.editWorkout(editing.id, draft).then((undo) => toast({ text: `Updated ${draft.name}`, undo }));
    }
  };

  return (
    <Sheet title={title} onClose={onClose}>
      <div class="card">
        <p class="hero-line">
          <strong data-testid="workout-kcal">{burn === null ? '–' : kcal(burn)}</strong> kcal above resting
        </p>
        <p class="detail">
          {kg === undefined
            ? 'Weigh in to work out the burn'
            : [`At ${lb(kg)} lb${editing === undefined ? '' : ' when logged'}`, ...(choice.kind === 'met' ? [`${amount(choice.met)} MET`] : [])].join(' · ')}
        </p>
      </div>
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
      <div class="pills">
        {MINUTES.map((m) => (
          <button type="button" class="pill" key={m} aria-pressed={parseNumber(minutesText) === m} onClick={() => setMinutesText(String(m))}>
            {m} min
          </button>
        ))}
      </div>
      {choice.kind === 'custom' && <p class="hint">As a machine or app reports it. Your resting burn comes off.</p>}
      {burn !== null && !storable && <p class="hint warn">More than one workout can burn. Check the minutes.</p>}
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

/** The day's workouts in the diary, under the meals. */
export function WorkoutsSection({ date, workouts }: { readonly date: LocalDate; readonly workouts: readonly Workout[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Workout | null>(null);
  const burned = workouts.reduce((sum, w) => sum + w.kcal, 0);

  return (
    <>
      <DaySection name="Workouts" total={workouts.length === 0 ? null : kcal(burned)} addLabel="Add workout" onAdd={() => setAdding(true)}>
        {workouts.map((workout) => (
          <li key={workout.id}>
            <Row name={workout.name} detail={minutesLabel(workout.minutes)} end={kcal(workout.kcal)} onClick={() => setEditing(workout)} />
          </li>
        ))}
      </DaySection>
      {adding && <WorkoutSheet date={date} onClose={() => setAdding(false)} />}
      {editing !== null && <WorkoutSheet date={date} editing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
