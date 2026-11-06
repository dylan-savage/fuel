import { useState } from 'preact/hooks';
import type { CoachWeek } from '../../domain/coach.js';
import { mondayOf, type LocalDate } from '../../domain/ids.js';
import type { DayKey, StandingText } from '../../domain/program.js';
import { TrainingNote } from '../../domain/notes.js';
import { useIntents, useLive, weekView, type WeekView } from '../views.js';
import { changeWords, clipped, count, pastMoment, shortDate, weekdayName } from './format.js';
import { ProgressSheet } from './Progress.js';
import { TrainDay, type OpenExercise } from './TrainDay.js';
import { ExpandRow, NoteField, Row, Sheet, TitleBar, useKeyboardAvoidance, useToast } from './ui.js';
import { WeighInSheet } from './Weight.js';

/** Long enough to fill the row's one line on any phone, short enough not to read a whole report to a screen reader. */
const COACH_LINE_LIMIT = 120;

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
                <p>{changeWords(item)}</p>
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
            void intents.addNote({ kind: 'week', date: today }, text).then((undo) => toast({ text: 'Saved for the coach', undo }));
          }}
        >
          Save note
        </button>
      </div>
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

function Week({ week, today, onDay }: { readonly week: WeekView; readonly today: LocalDate; readonly onDay: (key: DayKey) => void }) {
  const [sheet, setSheet] = useState<WeekSheet | null>(null);
  const planned = week.days.length;
  const closeSheet = () => setSheet(null);

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
      {planned > 0 && (
        <ul class="list" aria-label="Days">
          {week.days.map(({ plan, doneOn }) => (
            <li key={plan.key}>
              <Row name={plan.label} end={doneOn === null ? undefined : `Done ${weekdayName(doneOn)}`} chevron={doneOn === null} onClick={() => onDay(plan.key)} />
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
      {sheet === 'coach' && <CoachSheet week={week} today={today} onClose={closeSheet} />}
      {sheet === 'progress' && <ProgressSheet today={today} onClose={closeSheet} />}
      {sheet === 'program' && <ProgramSheet standing={week.standing} onClose={closeSheet} />}
      {sheet === 'weigh-in' && <WeighInSheet date={today} today={today} onClose={closeSheet} />}
    </>
  );
}

/** The week as the calendar and the version in effect say. */
function WeekScreen({ today, onDay }: { readonly today: LocalDate; readonly onDay: (key: DayKey) => void }) {
  const week = useLive((r) => weekView(r, today), [today]);
  return (
    <section class="screen train">
      <TitleBar title={`Week of ${shortDate(mondayOf(today), today)}`} />
      {week === null && <p class="week-count">There is no program yet.</p>}
      {week !== null && week !== undefined && <Week week={week} today={today} onDay={onDay} />}
    </section>
  );
}

/** Where he is in Train: the week, a day, or an exercise in a day. Held above the tab, so going to the Diary and back loses nothing. */
export type TrainPlace = { readonly key: DayKey; readonly open: OpenExercise | null } | null;

export function Train({ today, place, onPlace }: { readonly today: LocalDate; readonly place: TrainPlace; readonly onPlace: (place: TrainPlace) => void }) {
  if (place === null) return <WeekScreen today={today} onDay={(key) => onPlace({ key, open: null })} />;
  const { key } = place;
  return (
    <TrainDay
      key={`${key}:${today}`}
      day={{ key, date: today }}
      open={place.open}
      onOpen={(open) => onPlace({ key, open })}
      onBack={() => {
        onPlace(null);
        window.scrollTo(0, 0);
      }}
    />
  );
}
