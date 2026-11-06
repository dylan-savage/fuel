/** What he writes for the coach, one line at a time: what a line is about, and the one read of a day's lines. */
import { z } from 'zod';
import { LocalDate, Millis, TrainingNoteId, type PerformanceId, type SessionId } from './ids.js';
import { LiftId, SlotId, type Performance } from './lifts.js';
import { DayKey } from './program.js';
import { isOn, type DayRef, type Exercise, type Session } from './session.js';

const label = z.string().min(1).max(80);

/** What a line is about, by value, so it still reads after the plan moves on. An exercise is matched the way its sets are. */
export const NoteAbout = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('day'), key: DayKey, label }),
  z.looseObject({ kind: z.literal('exercise'), key: DayKey, slotId: SlotId.optional(), liftId: LiftId, label }),
]);
export type NoteAbout = z.infer<typeof NoteAbout>;

/**
 * A line he wrote for the coach. One document per line, so lines written on two phones offline
 * both survive and editing one never rewrites another. Absent `about` is a line about the week,
 * as Tell the coach writes. Written only by the phone.
 */
export const TrainingNote = z.looseObject({
  id: TrainingNoteId,
  date: LocalDate,
  text: z.string().min(1).max(2000),
  at: Millis,
  about: NoteAbout.optional(),
});
export type TrainingNote = z.infer<typeof TrainingNote>;

/** What a new line is about. */
export type NoteTarget =
  | { readonly kind: 'week'; readonly date: LocalDate }
  | { readonly kind: 'day'; readonly day: DayRef; readonly label: string }
  | { readonly kind: 'exercise'; readonly day: DayRef; readonly exercise: Exercise };

/** The targets the Note sheet lists lines for. */
export type DayNoteTarget = Exclude<NoteTarget, { readonly kind: 'week' }>;

/** Where a line is stored. This build writes only `note`. The other two are what older builds kept, read until he touches them. */
export type NoteRef = { readonly kind: 'note'; readonly id: TrainingNoteId } | { readonly kind: 'session'; readonly id: SessionId } | { readonly kind: 'performance'; readonly id: PerformanceId };

/** One line as the sheet shows and edits it. `about` is what an edit of an older build's line moves into. */
export interface NoteLine {
  readonly ref: NoteRef;
  readonly text: string;
  readonly date: LocalDate;
  readonly about: NoteAbout;
}

function aboutDay(target: DayNoteTarget): NoteAbout {
  if (target.kind === 'day') return { kind: 'day', key: target.day.key, label: target.label };
  const { slot, lift } = target.exercise;
  return { kind: 'exercise', key: target.day.key, ...(slot === null ? {} : { slotId: slot.id }), liftId: lift.liftId, label: lift.label };
}

/** The stored `about` of a target. Null for the week. */
export function aboutOf(target: NoteTarget): NoteAbout | null {
  return target.kind === 'week' ? null : aboutDay(target);
}

/** The document a new line makes. Null for blank text, which writes nothing. */
export function noteOf(target: NoteTarget, text: string, stamp: { readonly id: TrainingNoteId; readonly at: Millis }): TrainingNote | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const about = aboutOf(target);
  return { id: stamp.id, date: target.kind === 'week' ? target.date : target.day.date, text: trimmed, at: stamp.at, ...(about === null ? {} : { about }) };
}

/** A line of another day on the same date is not this day's. */
function isAbout(target: DayNoteTarget, about: NoteAbout): boolean {
  if (about.key !== target.day.key) return false;
  return target.kind === 'day' ? about.kind === 'day' : about.kind === 'exercise' && isOn(target.exercise, about);
}

/** What an older build kept on the session or the exercise's performances, which it overwrote rather than added to. */
function olderLines(target: DayNoteTarget, { session, performances }: { readonly session: Session | null; readonly performances: readonly Performance[] }): readonly NoteLine[] {
  if (target.kind === 'day') {
    return session?.note === undefined || session.day?.key !== target.day.key ? [] : [{ ref: { kind: 'session', id: session.id }, text: session.note, date: session.date, about: aboutDay(target) }];
  }
  return performances.flatMap((p): readonly NoteLine[] =>
    p.note === undefined || !isOn(target.exercise, p) ? [] : [{ ref: { kind: 'performance', id: p.id }, text: p.note, date: p.date, about: { kind: 'exercise', key: target.day.key, ...(p.slotId === undefined ? {} : { slotId: p.slotId }), liftId: p.liftId, label: p.label } }],
  );
}

/**
 * The lines on a day or one of its exercises, in the order written: an older build's line first,
 * because it kept no time, then documents by `at`.
 */
export function notesOn(target: DayNoteTarget, logs: { readonly notes: readonly TrainingNote[]; readonly session: Session | null; readonly performances: readonly Performance[] }): readonly NoteLine[] {
  const documents = logs.notes
    .filter((note) => note.date === target.day.date)
    .toSorted((a, b) => a.at - b.at)
    .flatMap((note): readonly NoteLine[] => (note.about === undefined || !isAbout(target, note.about) ? [] : [{ ref: { kind: 'note', id: note.id }, text: note.text, date: note.date, about: note.about }]));
  return [...olderLines(target, logs), ...documents];
}
