import { useState } from 'preact/hooks';
import type { CoachWeek, DiffItem, DiffKind } from '../../domain/coach.js';
import { mondayOf, type LocalDate } from '../../domain/ids.js';
import type { Block, DayKey, DayPart, ProgramNote, Slot, StandingText } from '../../domain/program.js';
import type { WeekDay } from '../../domain/progress.js';
import { dayPreviewView, useLive, weekView, type DayPreview, type WeekView } from '../views.js';
import { clipped, pastMoment, prescriptionText, shortDate, weekdayName } from './format.js';
import { Icon, Sheet, TitleBar } from './ui.js';
import { WeighInSheet } from './Weight.js';

const REPORT_LIMIT = 160;
const NOTE_LIMIT = 120;

function LongText({ text, limit }: { readonly text: string; readonly limit: number }) {
  const [open, setOpen] = useState(false);
  const short = clipped(text, limit);
  return (
    <>
      <p class="long-text">{open ? text : (short ?? text)}</p>
      {short !== null && (
        <button type="button" class="more-text" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </>
  );
}

function NoteCard({ note }: { readonly note: ProgramNote }) {
  return (
    <div class="card week-note">
      {note.title !== undefined && <p class="week-note-title">{note.title}</p>}
      <LongText text={note.text} limit={NOTE_LIMIT} />
    </div>
  );
}

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

function ChangesSheet({ changes, onClose }: { readonly changes: readonly DiffItem[]; readonly onClose: () => void }) {
  return (
    <Sheet title="What changed" onClose={onClose} closeLabel="Done">
      <ul class="list" aria-label="Changes">
        {changes.map((item, i) => (
          <li class="change" key={i}>
            <p>{CHANGE_WORDS[item.kind](item)}</p>
            {item.why !== null && <p class="change-why">{item.why}</p>}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function CoachCard({ coach, today }: { readonly coach: CoachWeek; readonly today: LocalDate }) {
  const [reading, setReading] = useState(false);
  if (coach.kind === 'quiet') {
    return (
      <div class="card coach-card">
        <p class="coach-quiet">No coach check-in this week</p>
      </div>
    );
  }
  const { at, report, changes } = coach;
  return (
    <section class="card coach-card" aria-label="Coach">
      <p class="coach-when">Coach, {pastMoment(at, today)}</p>
      {report?.title !== undefined && <p class="coach-title">{report.title}</p>}
      {report !== null && <LongText text={report.text} limit={REPORT_LIMIT} />}
      {changes.length > 0 && (
        <button type="button" class="text-button" onClick={() => setReading(true)}>
          What changed ({changes.length}) ›
        </button>
      )}
      {reading && <ChangesSheet changes={changes} onClose={() => setReading(false)} />}
    </section>
  );
}

function DayRow({ day, suggested, onOpen }: { readonly day: WeekDay; readonly suggested: boolean; readonly onOpen: () => void }) {
  const { plan, doneOn } = day;
  return (
    <li>
      <button type="button" class={suggested ? 'entry-row day-row suggested' : 'entry-row day-row'} aria-current={suggested ? 'true' : undefined} onClick={onOpen}>
        <span class="food-name">{plan.label}</span>
        {plan.minutes !== undefined && <span class="food-detail">{plan.minutes} min</span>}
        {doneOn !== null && <span class="entry-kcal">Done {weekdayName(doneOn)}</span>}
      </button>
    </li>
  );
}

function Exercise({ slot, preview, today }: { readonly slot: Slot; readonly preview: DayPreview; readonly today: LocalDate }) {
  const last = preview.lasts.get(slot.id) ?? null;
  const swaps = slot.swaps ?? [];
  return (
    <li class="exercise">
      <p class="exercise-name">{slot.label}</p>
      <p class="exercise-target">{prescriptionText(slot.target)}</p>
      {last !== null && (
        <p class="exercise-line">
          Last, {shortDate(last.date, today)}: {last.line}
        </p>
      )}
      {last?.addWeight === true && <p class="exercise-add">Add weight next time</p>}
      {swaps.length > 0 && <p class="exercise-line">Swaps: {swaps.map((swap) => swap.label).join(', ')}</p>}
      {slot.cue !== undefined && (
        <details class="tap-open">
          <summary>Cue</summary>
          <p>{slot.cue}</p>
        </details>
      )}
    </li>
  );
}

const phrase = (...words: readonly (string | undefined)[]) => words.filter((word) => word !== undefined).join(', ');

function headingOf({ block, superset }: DayPart): string | null {
  switch (block.kind) {
    case 'lifts': {
      const rest = block.restSeconds === undefined ? undefined : `rest ${block.restSeconds}s`;
      if (superset !== null) return phrase(block.title ?? `Superset ${superset.letter}`, `${superset.rounds} rounds`, rest);
      return phrase(block.title, rest) || null;
    }
    case 'checklist':
      return block.title ?? 'Checklist';
    case 'cardio':
      return block.title === undefined ? 'Cardio' : phrase(block.title, 'cardio');
  }
}

function BlockBody({ block, preview, today }: { readonly block: Block; readonly preview: DayPreview; readonly today: LocalDate }) {
  switch (block.kind) {
    case 'lifts':
      return (
        <ul class="list">
          {block.slots.map((slot) => (
            <Exercise key={slot.id} slot={slot} preview={preview} today={today} />
          ))}
        </ul>
      );
    case 'checklist':
      return (
        <ul class="list plan-items">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case 'cardio':
      return null;
  }
}

function DaySheet({ dayKey, label, today, onClose }: { readonly dayKey: DayKey; readonly label: string; readonly today: LocalDate; readonly onClose: () => void }) {
  const preview = useLive((r) => dayPreviewView(r, dayKey, today), [dayKey, today]);
  return (
    <Sheet title={label} onClose={onClose} closeLabel="Done">
      {preview === null && <p class="empty">This week's plan no longer holds this day.</p>}
      {preview !== null && preview !== undefined && (
        <>
          {preview.notes.map((note, i) => (
            <NoteCard key={i} note={note} />
          ))}
          {preview.parts.map((part) => {
            const heading = headingOf(part);
            const { block } = part;
            const optional = block.optional === true;
            return (
              <section class="plan-block" key={block.id} aria-label={heading ?? undefined}>
                {(heading !== null || optional) && (
                  <header class="plan-block-head">
                    <h4 class="plan-block-heading">{heading}</h4>
                    {optional && <span class="plan-tag">Optional</span>}
                  </header>
                )}
                {block.note !== undefined && <p class="plan-note">{block.note}</p>}
                <BlockBody block={block} preview={preview} today={today} />
              </section>
            );
          })}
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
            <details class="standing">
              <summary>{section.title}</summary>
              <p>{section.text}</p>
            </details>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Week({ week, today }: { readonly week: WeekView; readonly today: LocalDate }) {
  const [open, setOpen] = useState<WeekDay | null>(null);
  const [weighing, setWeighing] = useState(false);
  const [reading, setReading] = useState(false);
  const planned = week.days.length;
  const chips = week.weighedInToday ? [] : [{ label: 'Weigh in', onClick: () => setWeighing(true) }];

  return (
    <>
      {planned === 0 ? (
        <p class="week-count">Nothing is planned this week.</p>
      ) : (
        <>
          <p class="week-count" data-testid="week-count">
            {week.done} of {planned} done{week.minimum === null ? '' : `, minimum ${week.minimum}`}
          </p>
          <div class="week-strip" role="presentation">
            {week.strip.map((done, i) => (
              <span key={i} class={done ? 'done' : undefined} />
            ))}
          </div>
        </>
      )}
      <CoachCard coach={week.coach} today={today} />
      {planned > 0 && (
        <ul class="list" aria-label="Days">
          {week.days.map((day) => (
            <DayRow key={day.plan.key} day={day} suggested={week.suggested?.key === day.plan.key} onOpen={() => setOpen(day)} />
          ))}
        </ul>
      )}
      {chips.length > 0 && (
        <div class="pills">
          {chips.map((chip) => (
            <button type="button" class="pill" key={chip.label} onClick={chip.onClick}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {week.notes.map((note, i) => (
        <NoteCard key={i} note={note} />
      ))}
      {week.standing.length > 0 && (
        <ul class="list">
          <li>
            <button type="button" class="row-button disclosure" onClick={() => setReading(true)}>
              Program
              <Icon name="chevronRight" />
            </button>
          </li>
        </ul>
      )}
      {open !== null && <DaySheet dayKey={open.plan.key} label={open.plan.label} today={today} onClose={() => setOpen(null)} />}
      {reading && <ProgramSheet standing={week.standing} onClose={() => setReading(false)} />}
      {weighing && <WeighInSheet date={today} today={today} onClose={() => setWeighing(false)} />}
    </>
  );
}

/** The week as the calendar and the version in effect say. Read-only: Start, logging and Finish come later, with Start on the suggested row. */
export function Train({ today }: { readonly today: LocalDate }) {
  const week = useLive((r) => weekView(r, today), [today]);
  return (
    <section class="screen train">
      <TitleBar title={`Week of ${shortDate(mondayOf(today), today)}`} />
      {week === null && <p class="empty">There is no program yet.</p>}
      {week !== null && week !== undefined && <Week week={week} today={today} />}
    </section>
  );
}
