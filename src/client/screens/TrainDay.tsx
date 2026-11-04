/** One day on today's date: its exercises as rows in no order he has to follow, each opening its own screen. */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Performance, SlotId } from '../../domain/lifts.js';
import { exerciseCount, slotIn, type CardioBlock, type ChecklistBlock, type DayPart, type PlannedDay, type ProgramNote, type Slot } from '../../domain/program.js';
import { lastLineOf } from '../../domain/progress.js';
import { blockDone, liftInSlot, slotLog, type DayRef, type LiftChoice } from '../../domain/session.js';
import { useTrainDraft } from '../trainDraft.js';
import { dayLiftIds, dayScreenView, lastTimesView, useIntents, useLive, type DayScreenView } from '../views.js';
import { ExerciseScreen } from './Exercise.js';
import { checklistLabel, count, planSections, prescriptionText, shortDate } from './format.js';
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
interface DayRows {
  readonly view: DayScreenView;
  readonly day: DayRef;
  /** Last-time reads, from lastTimesView. */
  readonly rows: readonly Performance[];
  readonly liftOf: (slot: Slot) => LiftChoice;
  readonly onExercise: (slot: Slot) => void;
  readonly onCardio: () => void;
}

function ExerciseRow({ slot, view, day, rows, liftOf, onExercise }: DayRows & { readonly slot: Slot }) {
  const lift = liftOf(slot);
  const log = slotLog(slot, view);
  const last = lastLineOf({ lift: lift.liftId, rows, book: view.book, before: day.date });
  return (
    <Row
      name={lift.label}
      detail={last === null ? undefined : `${last.line} · ${shortDate(last.date, day.date)}`}
      end={
        <span class="exercise-end">
          {prescriptionText(slot.target)}
          {log.skipped ? <span class="detail">Skipped</span> : <Dots filled={log.done} total={log.dots} />}
        </span>
      }
      chevron
      onClick={() => onExercise(slot)}
    />
  );
}

function ChecklistRow({ block, view, day }: DayRows & { readonly block: ChecklistBlock }) {
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

function CardioRow({ block, view, onCardio }: DayRows & { readonly block: CardioBlock }) {
  return <Row name={block.title ?? 'Cardio'} detail={block.note ?? (block.title === undefined ? undefined : 'Cardio')} end={blockDone(block, view) ? 'Done' : undefined} chevron onClick={onCardio} />;
}

function PartRows({ part: { block }, ...rows }: DayRows & { readonly part: DayPart }) {
  switch (block.kind) {
    case 'lifts':
      return (
        <>
          {block.slots.map((slot) => (
            <li key={slot.id}>
              <ExerciseRow slot={slot} {...rows} />
            </li>
          ))}
        </>
      );
    case 'checklist':
      return (
        <li>
          <ChecklistRow block={block} {...rows} />
        </li>
      );
    case 'cardio':
      return (
        <li>
          <CardioRow block={block} {...rows} />
        </li>
      );
  }
}

function PartLists({ parts, ...rows }: DayRows & { readonly parts: readonly DayPart[] }) {
  return (
    <>
      {planSections(parts).map((section) => (
        <section class="plan-section" key={section.parts[0]?.block.id} aria-label={section.label ?? undefined}>
          {section.label !== null && <h3 class="section-heading">{section.label}</h3>}
          <ul class="list">
            {section.parts.map((part) => (
              <PartRows key={part.block.id} part={part} {...rows} />
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

function DayScreen({ onBack, ...rows }: DayRows & { readonly onBack: () => void }) {
  const { plan, notes, parts } = rows.view;
  const required = parts.filter((part) => part.block.optional !== true);
  const optional = parts.filter((part) => part.block.optional === true);
  const line = dayLine(plan);
  return (
    <section class="screen train">
      <BackButton onBack={onBack} />
      <TitleBar title={plan.label} />
      {line !== '' && <p class="week-count">{line}</p>}
      {notes.length > 0 && (
        <ul class="list" aria-label="Day notes">
          {notes.map((note, i) => (
            <li key={i}>
              <ExpandRow name={noteLine(note)} clamp />
            </li>
          ))}
        </ul>
      )}
      <PartLists parts={required} {...rows} />
      {optional.length > 0 && (
        <section class="plan-section" aria-label="Optional">
          <ul class="list">
            <li>
              <ExpandRow name="Optional" detail={optional.flatMap(partNames).join(', ')}>
                <PartLists parts={optional} {...rows} />
              </ExpandRow>
            </li>
          </ul>
        </section>
      )}
    </section>
  );
}

/** Holds what the day and its exercises share, so going between them draws no gap and loses no place. */
function HeldDay({ view, day, slotId, onSlot, onBack }: { readonly view: DayScreenView; readonly day: DayRef; readonly slotId: SlotId | null; readonly onSlot: (slot: SlotId | null) => void; readonly onBack: () => void }) {
  const [draft, setDraft] = useTrainDraft(day);
  const [logging, setLogging] = useState(false);
  const liftIds = dayLiftIds(view, Object.values(draft.swaps));
  const rows = useLive((r) => lastTimesView(r, liftIds, day.date), [liftIds.join(), day.date]);
  const open = slotId === null ? undefined : slotIn(view.plan, slotId);
  const liftOf = (slot: Slot) => draft.swaps[slot.id] ?? liftInSlot(slot, view.performances);

  // Back lands where he left, because he goes between the day and its exercises all session.
  const dayScroll = useRef(0);
  const onDay = open === undefined;
  useLayoutEffect(() => {
    if (onDay) window.scrollTo(0, dayScroll.current);
  }, [onDay]);

  if (rows === undefined) return null;
  if (open !== undefined) {
    return <ExerciseScreen view={view} day={day} block={open.block} slot={open.slot} lift={liftOf(open.slot)} rows={rows} draft={draft} onDraft={setDraft} onBack={() => onSlot(null)} />;
  }
  return (
    <>
      <DayScreen
        view={view}
        day={day}
        rows={rows}
        liftOf={liftOf}
        onExercise={(slot) => {
          dayScroll.current = window.scrollY;
          onSlot(slot.id);
        }}
        onCardio={() => setLogging(true)}
        onBack={onBack}
      />
      {logging && <WorkoutSheet date={day.date} onClose={() => setLogging(false)} />}
    </>
  );
}

export function TrainDay({ day, slotId, onSlot, onBack }: { readonly day: DayRef; readonly slotId: SlotId | null; readonly onSlot: (slot: SlotId | null) => void; readonly onBack: () => void }) {
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
  return <HeldDay view={view} day={day} slotId={slotId} onSlot={onSlot} onBack={onBack} />;
}
