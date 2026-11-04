import { useState } from 'preact/hooks';
import type { CoachWeek, DiffItem, DiffKind } from '../../domain/coach.js';
import { mondayOf, type LocalDate } from '../../domain/ids.js';
import { exerciseCount, type DayKey, type DayPart, type PlannedDay, type ProgramNote, type Slot, type StandingText } from '../../domain/program.js';
import { TrainingNote, type SessionLogs } from '../../domain/session.js';
import { dayPreviewView, useIntents, useLive, weekView, type DayPreview, type WeekView } from '../views.js';
import { checklistLabel, clipped, count, pastMoment, planSections, prescriptionText, shortDate, targetNotes, weekdayName } from './format.js';
import { ProgressSheet } from './Progress.js';
import { SessionScreen, useKeyboardAvoidance } from './Session.js';
import { ExpandRow, NoteField, Row, Sheet, TitleBar, useToast } from './ui.js';
import { WeighInSheet } from './Weight.js';

/** Long enough to fill the row's one line on any phone, short enough not to read a whole report to a screen reader. */
const COACH_LINE_LIMIT = 120;

const withoutLift = (text: string | null) => text?.slice(text.indexOf(' ') + 1);

/** A prescription names the lift first, which only says anything when the lift itself changed. */
function prescriptionChange({ label, before, after }: DiffItem): string {
  const sameLift = before?.split(' ')[0] === after?.split(' ')[0];
  return `${label} went from ${sameLift ? withoutLift(before) : before} to ${sameLift ? withoutLift(after) : after}`;
}

const CHANGE_WORDS: Readonly<Record<DiffKind, (item: DiffItem) => string>> = {
  'day-removed': ({ label }) => `${label} is gone`,
  'block-removed': ({ label }) => `${label} is gone`,
  'slot-removed': ({ label }) => `${label} is gone`,
  'cue-removed': ({ label }) => `The cue on ${label} is gone`,
  'standing-removed': ({ label }) => `${label} left the program`,
  'prescription-changed': prescriptionChange,
  'day-added': ({ label }) => `${label} is new`,
  'block-added': ({ label }) => `${label} is new`,
  'slot-added': ({ label }) => `${label} is new`,
  'slot-renamed': ({ label, after }) => `${label} is now called ${after}`,
  'cue-added': ({ label }) => `${label} has a new cue`,
  'cue-edited': ({ label }) => `The cue on ${label} changed`,
  'standing-added': ({ label }) => `${label} joined the program`,
  'standing-edited': ({ label }) => `${label} changed in the program`,
};

/** The Coach row's one line: the report if there is one, else how much changed. */
function coachLine(coach: CoachWeek): string | undefined {
  if (coach.kind === 'quiet') return undefined;
  if (coach.report !== null) return clipped(coach.report.text, COACH_LINE_LIMIT) ?? coach.report.text;
  return coach.changes.length > 0 ? count(coach.changes.length, 'change') : undefined;
}

/** Everything the coach says, and the way to answer. */
function CoachSheet({ week, today, onClose }: { readonly week: WeekView; readonly today: LocalDate; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const [text, setText] = useState('');
  useKeyboardAvoidance();
  const { coach, notes } = week;
  const changes = coach.kind === 'quiet' ? [] : coach.changes;
  const valid = TrainingNote.shape.text.safeParse(text.trim()).success;
  return (
    <Sheet title="Coach" onClose={onClose} closeLabel="Done">
      {coach.kind === 'quiet' ? (
        <p class="detail">No check-in this week</p>
      ) : (
        <div class="card">
          <p class="detail">{pastMoment(coach.at, today)}</p>
          {coach.report?.title !== undefined && <p class="coach-title">{coach.report.title}</p>}
          {coach.report !== null && <p class="long-text">{coach.report.text}</p>}
        </div>
      )}
      {changes.length > 0 && (
        <>
          <h3 class="section-heading">What changed</h3>
          <ul class="list" aria-label="Changes">
            {changes.map((item, i) => (
              <li class="row-text" key={i}>
                <p>{CHANGE_WORDS[item.kind](item)}</p>
                {item.why !== null && <p class="detail">{item.why}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.length > 0 && (
        <>
          <h3 class="section-heading">This week's notes</h3>
          <ul class="list" aria-label="Notes">
            {notes.map((note, i) => (
              <li class="row-text" key={i}>
                {note.title !== undefined && <p class="coach-title">{note.title}</p>}
                <p class="long-text">{note.text}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <NoteField label="Tell the coach" labelClass="section-heading" placeholder="For Sunday's review" value={text} onInput={setText} maxLength={2000} />
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={!valid}
          onClick={() => {
            onClose();
            void intents.tellCoach(text, today).then((undo) => toast({ text: 'Saved for the coach', undo }));
          }}
        >
          Save note
        </button>
      </div>
    </Sheet>
  );
}

/** "35 min · 8 exercises". */
function dayLine(plan: PlannedDay): string {
  const exercises = exerciseCount(plan);
  return [...(plan.minutes === undefined ? [] : [`${plan.minutes} min`]), ...(exercises === 0 ? [] : [count(exercises, 'exercise')])].join(' · ');
}

/** The hero. A tap anywhere on it previews the day, and Start sits on top of that. */
function NextDay({ plan, onOpen, onStart }: { readonly plan: PlannedDay; readonly onOpen: () => void; readonly onStart: () => void }) {
  return (
    <section class="card next-day" aria-label="Next day">
      <button type="button" class="next-day-open" onClick={onOpen}>
        <span class="hero-number">{plan.label}</span>
        <span class="detail">{dayLine(plan)}</span>
      </button>
      <button type="button" class="primary" onClick={onStart}>
        Start
      </button>
    </section>
  );
}

function ExerciseRow({ slot, part, preview, today }: { readonly slot: Slot; readonly part: DayPart; readonly preview: DayPreview; readonly today: LocalDate }) {
  const { block, superset } = part;
  const last = preview.lasts.get(slot.id) ?? null;
  const swaps = slot.swaps ?? [];
  const more = [
    ...(superset === null && block.title !== undefined && block.title !== slot.label ? [block.title] : []),
    ...targetNotes(slot.target),
    ...(superset === null && block.kind === 'lifts' && block.restSeconds !== undefined ? [`Rest ${block.restSeconds}s`] : []),
    ...(swaps.length > 0 ? [`Swaps: ${swaps.map((swap) => swap.label).join(', ')}`] : []),
    ...(block.note === undefined ? [] : [block.note]),
    ...(slot.cue === undefined ? [] : [slot.cue]),
  ];
  const row = {
    name: slot.label,
    detail: last === null ? undefined : `${last.line} · ${shortDate(last.date, today)}`,
    end: (
      <span class="exercise-end">
        {prescriptionText(slot.target)}
        {last?.addWeight === true && <span class="mark-good">Add weight</span>}
      </span>
    ),
  };
  return more.length === 0 ? (
    <Row {...row} />
  ) : (
    <ExpandRow {...row}>
      {more.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </ExpandRow>
  );
}

function PartRows({ part, preview, today }: { readonly part: DayPart; readonly preview: DayPreview; readonly today: LocalDate }) {
  const { block } = part;
  switch (block.kind) {
    case 'lifts':
      return (
        <>
          {block.slots.map((slot) => (
            <li key={slot.id}>
              <ExerciseRow slot={slot} part={part} preview={preview} today={today} />
            </li>
          ))}
        </>
      );
    case 'checklist':
      return (
        <li>
          <ExpandRow name={checklistLabel(block)}>
            {block.note !== undefined && <p>{block.note}</p>}
            {block.items.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </ExpandRow>
        </li>
      );
    case 'cardio': {
      const row = { name: block.title ?? 'Cardio', detail: block.title === undefined ? undefined : 'Cardio' };
      return <li>{block.note === undefined ? <Row {...row} /> : <ExpandRow {...row}><p>{block.note}</p></ExpandRow>}</li>;
    }
  }
}

function PartLists({ parts, preview, today }: { readonly parts: readonly DayPart[]; readonly preview: DayPreview; readonly today: LocalDate }) {
  return (
    <>
      {planSections(parts).map((section) => (
        <section class="plan-section" key={section.parts[0]?.block.id} aria-label={section.label ?? undefined}>
          {section.label !== null && <h3 class="section-heading">{section.label}</h3>}
          <ul class="list">
            {section.parts.map((part) => (
              <PartRows key={part.block.id} part={part} preview={preview} today={today} />
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

function DaySheet({ plan, today, onClose, onStart }: { readonly plan: PlannedDay; readonly today: LocalDate; readonly onClose: () => void; readonly onStart: () => void }) {
  const preview = useLive((r) => dayPreviewView(r, plan.key, today), [plan.key, today]);
  const required = preview?.parts.filter((part) => part.block.optional !== true) ?? [];
  const optional = preview?.parts.filter((part) => part.block.optional === true) ?? [];
  const line = dayLine(plan);
  return (
    <Sheet title={plan.label} onClose={onClose} closeLabel="Done">
      {preview === null && <p class="detail">Not in this week's plan</p>}
      {preview !== null && preview !== undefined && (
        <>
          {line !== '' && <p class="detail sheet-lead">{line}</p>}
          {preview.notes.length > 0 && (
            <ul class="list" aria-label="Day notes">
              {preview.notes.map((note, i) => (
                <li key={i}>
                  <ExpandRow name={noteLine(note)} clamp />
                </li>
              ))}
            </ul>
          )}
          <PartLists parts={required} preview={preview} today={today} />
          {optional.length > 0 && (
            <section class="plan-section" aria-label="Optional">
              <ul class="list">
                <li>
                  <ExpandRow name="Optional" detail={optional.flatMap(partNames).join(', ')}>
                    <PartLists parts={optional} preview={preview} today={today} />
                  </ExpandRow>
                </li>
              </ul>
            </section>
          )}
          <div class="day-start">
            <button type="button" class="primary" onClick={onStart}>
              Start
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function ProgramSheet({ standing, onClose }: { readonly standing: readonly StandingText[]; readonly onClose: () => void }) {
  return (
    <Sheet title="Program" onClose={onClose} closeLabel="Done">
      <ul class="list" aria-label="Program sections">
        {standing.map((section) => (
          <li key={section.key}>
            <ExpandRow name={section.title}>
              <p>{section.text}</p>
            </ExpandRow>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** Which sheet is over the week. */
type WeekSheet = 'coach' | 'progress' | 'program' | 'weigh-in';

function Week({ week, today }: { readonly week: WeekView; readonly today: LocalDate }) {
  const intents = useIntents();
  const toast = useToast();
  const [previewing, setPreviewing] = useState<PlannedDay | null>(null);
  const [sheet, setSheet] = useState<WeekSheet | null>(null);
  const planned = week.days.length;
  const next = week.suggested;
  const others = week.days.filter((day) => day.plan.key !== next?.key);
  const closeSheet = () => setSheet(null);
  const start = ({ key, label }: { readonly key: DayKey; readonly label: string }) => {
    setPreviewing(null);
    void intents.startSession(key, today).then((undo) => {
      if (undo !== null) toast({ text: `Started ${label}`, undo });
    });
  };

  return (
    <>
      {planned === 0 ? (
        <p class="week-count">Nothing planned this week</p>
      ) : (
        <>
          <p class="week-count" data-testid="week-count">
            {week.done} of {planned} done
          </p>
          <div class="week-strip" role="presentation">
            {week.strip.map((done, i) => (
              <span key={i} class={done ? 'done' : undefined} />
            ))}
          </div>
        </>
      )}
      {next !== null && <NextDay plan={next} onOpen={() => setPreviewing(next)} onStart={() => start(next)} />}
      {others.length > 0 && (
        <ul class="list" aria-label="Days">
          {others.map(({ plan, doneOn }) => (
            <li key={plan.key}>
              <Row name={plan.label} end={doneOn === null ? undefined : `Done ${weekdayName(doneOn)}`} chevron={doneOn === null} onClick={() => setPreviewing(plan)} />
            </li>
          ))}
        </ul>
      )}
      <ul class="list" aria-label="More">
        <li>
          <Row name="Coach" detail={coachLine(week.coach)} chevron onClick={() => setSheet('coach')} />
        </li>
        <li>
          <Row name="Progress" chevron onClick={() => setSheet('progress')} />
        </li>
        {week.standing.length > 0 && (
          <li>
            <Row name="Program" chevron onClick={() => setSheet('program')} />
          </li>
        )}
        {!week.weighedInToday && (
          <li>
            <Row name="Weigh in" chevron onClick={() => setSheet('weigh-in')} />
          </li>
        )}
      </ul>
      {previewing !== null && <DaySheet plan={previewing} today={today} onClose={() => setPreviewing(null)} onStart={() => start(previewing)} />}
      {sheet === 'coach' && <CoachSheet week={week} today={today} onClose={closeSheet} />}
      {sheet === 'progress' && <ProgressSheet today={today} onClose={closeSheet} />}
      {sheet === 'program' && <ProgramSheet standing={week.standing} onClose={closeSheet} />}
      {sheet === 'weigh-in' && <WeighInSheet date={today} today={today} onClose={closeSheet} />}
    </>
  );
}

/** The week as the calendar and the version in effect say. */
function WeekScreen({ today }: { readonly today: LocalDate }) {
  const week = useLive((r) => weekView(r, today), [today]);
  return (
    <section class="screen train">
      <TitleBar title={`Week of ${shortDate(mondayOf(today), today)}`} />
      {week === null && <p class="week-count">There is no program yet.</p>}
      {week !== null && week !== undefined && <Week week={week} today={today} />}
    </section>
  );
}

/** An open session comes first. `open` is undefined only until IndexedDB first answers, which draws nothing so the week cannot flash. */
export function Train({ today, open }: { readonly today: LocalDate; readonly open: SessionLogs | null | undefined }) {
  if (open === undefined) return null;
  return open === null ? <WeekScreen today={today} /> : <SessionScreen logs={open} today={today} />;
}
