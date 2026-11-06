/** One day on today's date: its exercises as rows in no order he has to follow, each opening its own screen. */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Performance, SlotId } from '../../domain/lifts.js';
import { exerciseCount, slotIn, type CardioBlock, type ChecklistBlock, type DayPart, type PlannedDay, type ProgramNote, type Slot } from '../../domain/program.js';
import { lastLineOf } from '../../domain/progress.js';
import { blockDone, exerciseLog, liftInSlot, liftsOnDay, type DayRef, type Exercise, type LiftChoice } from '../../domain/session.js';
import { useTrainDraft } from '../trainDraft.js';
import { dayLiftIds, dayScreenView, lastTimesView, useIntents, useLive, type DayScreenView } from '../views.js';
import { ExerciseScreen } from './Exercise.js';
import { checklistLabel, count, planSections, prescriptionText, shortDate } from './format.js';
import { LiftPicker } from './LiftPicker.js';
import { BackButton, ExpandRow, Row, TitleBar, useKeyboardAvoidance, useToast } from './ui.js';
import { WorkoutSheet } from './Workouts.js';

/** "35 min · 8 exercises". */
function dayLine(plan: PlannedDay): string {
  const exercises = exerciseCount(plan);
  return [...(plan.minutes === undefined ? [] : [`${plan.minutes} min`]), ...(exercises === 0 ? [] : [count(exercises, 'exercise')])].join(' · ');
}

function Dots({ filled, total }: { readonly filled: number; readonly total: number }) {
  return (
    <span class="dots" role="img" aria-label={`${filled} of ${total} logged`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} class={i < filled ? 'filled' : undefined} />
      ))}
    </span>
  );
}

/** What every row of the day reads and does. */
interface RowContext {
  readonly view: DayScreenView;
  readonly day: DayRef;
  /** From lastTimesView. */
  readonly lastTimes: readonly Performance[];
  readonly liftOf: (slot: Slot) => LiftChoice;
  readonly onExercise: (exercise: Exercise) => void;
  readonly onCardio: (block: CardioBlock) => void;
}

/** A planned row shows its prescription over the dots, and an added one only its dots. */
function ExerciseRow({ exercise, view, day, lastTimes, onExercise }: RowContext & { readonly exercise: Exercise }) {
  const { slot, lift } = exercise;
  const log = exerciseLog(exercise, view);
  const last = lastLineOf({ lift: lift.liftId, rows: lastTimes, book: view.book, before: day.date });
  return (
    <Row
      name={lift.label}
      detail={last === null ? undefined : `${last.line} · ${shortDate(last.date, day.date)}`}
      end={
        <span class="exercise-end">
          {slot !== null && prescriptionText(slot.target)}
          {log.skipped ? <span class="detail">Skipped</span> : <Dots filled={log.done} total={log.dots} />}
        </span>
      }
      chevron
      onClick={() => onExercise(exercise)}
    />
  );
}

function ChecklistRow({ block, view, day }: RowContext & { readonly block: ChecklistBlock }) {
  const intents = useIntents();
  const toast = useToast();
  const title = block.title ?? 'Checklist';
  const done = blockDone(block, view);
  return (
    <ExpandRow name={checklistLabel(block)} end={done ? 'Done' : undefined}>
      {block.note !== undefined && <p>{block.note}</p>}
      {block.items.map((item) => (
        <p key={item}>{item}</p>
      ))}
      {!done && (
        <div class="quiet-actions start">
          <button type="button" class="text-button" aria-label={`${title} done`} onClick={() => void intents.checkBlock(day, block.id).then((undo) => toast({ text: `${title} done`, undo }))}>
            Done
          </button>
        </div>
      )}
    </ExpandRow>
  );
}

function CardioRow({ block, view, onCardio }: RowContext & { readonly block: CardioBlock }) {
  return <Row name={block.title ?? 'Cardio'} detail={block.note ?? (block.title === undefined ? undefined : 'Cardio')} end={blockDone(block, view) ? 'Done' : undefined} chevron onClick={() => onCardio(block)} />;
}

function PartRows({ part: { block }, ...context }: RowContext & { readonly part: DayPart }) {
  switch (block.kind) {
    case 'lifts':
      return (
        <>
          {block.slots.map((slot) => (
            <li key={slot.id}>
              <ExerciseRow exercise={{ slot, lift: context.liftOf(slot) }} {...context} />
            </li>
          ))}
        </>
      );
    case 'checklist':
      return (
        <li>
          <ChecklistRow block={block} {...context} />
        </li>
      );
    case 'cardio':
      return (
        <li>
          <CardioRow block={block} {...context} />
        </li>
      );
  }
}

function PartLists({ parts, ...context }: RowContext & { readonly parts: readonly DayPart[] }) {
  return (
    <>
      {planSections(parts).map((section) => (
        <section class="plan-section" key={section.parts[0]?.block.id} aria-label={section.label ?? undefined}>
          {section.label !== null && <h3 class="section-heading">{section.label}</h3>}
          <ul class="list">
            {section.parts.map((part) => (
              <PartRows key={part.block.id} part={part} {...context} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const noteLine = ({ title, text }: ProgramNote) => (title === undefined ? text : `${title}: ${text}`);

function partNames({ block }: DayPart): readonly string[] {
  switch (block.kind) {
    case 'lifts':
      return block.slots.map((slot) => slot.label);
    case 'checklist':
      return [block.title ?? 'Checklist'];
    case 'cardio':
      return [block.title ?? 'Cardio'];
  }
}

function DayScreen({ hidden, onAdd, onBack, ...context }: RowContext & { readonly hidden: boolean; readonly onAdd: () => void; readonly onBack: () => void }) {
  const { plan, notes, parts, added } = context.view;
  const required = parts.filter((part) => part.block.optional !== true);
  const optional = parts.filter((part) => part.block.optional === true);
  const line = dayLine(plan);
  return (
    <section class="screen train" hidden={hidden}>
      <BackButton onBack={onBack} />
      <TitleBar title={plan.label} />
      {line !== '' && <p class="detail">{line}</p>}
      {notes.length > 0 && (
        <ul class="list" aria-label="Day notes">
          {notes.map((note, i) => (
            <li key={i}>
              <ExpandRow name={noteLine(note)} clamp />
            </li>
          ))}
        </ul>
      )}
      <PartLists parts={required} {...context} />
      {added.length > 0 && (
        <section class="plan-section" aria-label="Added">
          <ul class="list">
            {added.map((lift) => (
              <li key={lift.liftId}>
                <ExerciseRow exercise={{ slot: null, lift }} {...context} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {optional.length > 0 && (
        <section class="plan-section" aria-label="Optional">
          <ul class="list">
            <li>
              <ExpandRow name="Optional" detail={optional.flatMap(partNames).join(', ')}>
                <PartLists parts={optional} {...context} />
              </ExpandRow>
            </li>
          </ul>
        </section>
      )}
      <div class="quiet-actions start">
        <button type="button" class="text-button" onClick={onAdd}>
          Add exercise
        </button>
      </div>
    </section>
  );
}

/** Which exercise is open: a slot by id, or an added lift, which needs its label before it has a set. */
export type OpenExercise = { readonly kind: 'slot'; readonly slotId: SlotId } | { readonly kind: 'added'; readonly lift: LiftChoice };

/** Undefined when the slot left the plan, which lands him on the day. */
function exerciseAt(open: OpenExercise | null, plan: PlannedDay, liftOf: (slot: Slot) => LiftChoice): Exercise | undefined {
  if (open === null) return undefined;
  if (open.kind === 'added') return { slot: null, lift: open.lift };
  const slot = slotIn(plan, open.slotId)?.slot;
  return slot === undefined ? undefined : { slot, lift: liftOf(slot) };
}

/** Holds what the day and its exercises share, so going between them draws no gap and loses no place. */
function HeldDay({ view, day, place, onOpen, onBack }: { readonly view: DayScreenView; readonly day: DayRef; readonly place: OpenExercise | null; readonly onOpen: (open: OpenExercise | null) => void; readonly onBack: () => void }) {
  const [draft, setDraft] = useTrainDraft(day);
  const [cardio, setCardio] = useState<CardioBlock | null>(null);
  const [picking, setPicking] = useState(false);
  const liftOf = (slot: Slot) => draft.swaps[slot.id] ?? liftInSlot(slot, view.performances);
  const open = exerciseAt(place, view.plan, liftOf);
  const liftIds = dayLiftIds(view, [...Object.values(draft.swaps), ...(open?.slot === null ? [open.lift] : [])]);
  const lastTimes = useLive((r) => lastTimesView(r, liftIds, day.date), [liftIds.join(), day.date]);

  // Back lands where he left, because he goes between the day and its exercises all session.
  const dayScroll = useRef(0);
  const openExercise = ({ slot, lift }: Exercise) => {
    dayScroll.current = window.scrollY;
    onOpen(slot === null ? { kind: 'added', lift } : { kind: 'slot', slotId: slot.id });
  };
  const onDay = open === undefined;
  useLayoutEffect(() => {
    if (onDay) window.scrollTo(0, dayScroll.current);
  }, [onDay]);

  if (lastTimes === undefined) return null;
  return (
    <>
      {/* Kept under the exercise rather than rebuilt, so the rows he opened are still open on Back. */}
      <DayScreen
        hidden={!onDay}
        view={view}
        day={day}
        lastTimes={lastTimes}
        liftOf={liftOf}
        onExercise={openExercise}
        onCardio={setCardio}
        onAdd={() => setPicking(true)}
        onBack={onBack}
      />
      {open !== undefined && <ExerciseScreen view={view} day={day} exercise={open} rows={lastTimes} draft={draft} onDraft={setDraft} onBack={() => onOpen(null)} />}
      {cardio !== null && <WorkoutSheet date={day.date} day={day} lead={cardio.note} onClose={() => setCardio(null)} />}
      {picking && (
        <LiftPicker
          title="Add exercise"
          pickFor={{ kind: 'add', onDay: liftsOnDay(view.plan, view.added, liftOf) }}
          day={day}
          lifts={view.lifts}
          book={view.book}
          onPick={(lift) => {
            setPicking(false);
            openExercise({ slot: null, lift });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

export function TrainDay({ day, open, onOpen, onBack }: { readonly day: DayRef; readonly open: OpenExercise | null; readonly onOpen: (open: OpenExercise | null) => void; readonly onBack: () => void }) {
  const view = useLive((r) => dayScreenView(r, day), [day.key, day.date]);
  useKeyboardAvoidance();
  if (view === undefined) return null;
  if (view === null) {
    return (
      <section class="screen train">
        <BackButton onBack={onBack} />
        <p class="week-count">Not in this week's plan</p>
      </section>
    );
  }
  return <HeldDay view={view} day={day} place={open} onOpen={onOpen} onBack={onBack} />;
}
