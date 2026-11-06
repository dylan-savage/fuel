import { describe, expect, it } from 'vitest';
import { TrainingNoteId } from '../src/domain/ids.js';
import { TrainingNote, noteOf, notesOn, type DayNoteTarget } from '../src/domain/notes.js';
import { T0, day, dayKey, lb, lift, ms, performance, session, slot } from './training.fixtures.js';

const DATE = day('2030-03-04');
const PUSH = { key: dayKey('push'), date: DATE };
const bench = slot('a1', 'bench-press', 3, { label: 'Bench press' });
const onBench = { slot: bench, lift: { liftId: bench.liftId, label: 'Bench press' } };
const calves = { slot: null, lift: { liftId: lift('calf-raise'), label: 'Calf raise' } };
const stamp = (n: number) => ({ id: TrainingNoteId.parse(`0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5${n}`), at: ms(T0 + n) });

describe('noteOf', () => {
  it('makes nothing of blank text', () => {
    expect(noteOf({ kind: 'day', day: PUSH, label: 'Push' }, '  \n ', stamp(1))).toBeNull();
  });

  it('stores what each line is about by value, and a week line has none', () => {
    expect(noteOf({ kind: 'week', date: DATE }, ' Invented. ', stamp(1))).toEqual({ ...stamp(1), date: DATE, text: 'Invented.' });
    expect(noteOf({ kind: 'day', day: PUSH, label: 'Push' }, 'Invented.', stamp(1))?.about).toEqual({ kind: 'day', key: 'push', label: 'Push' });
    expect(noteOf({ kind: 'exercise', day: PUSH, exercise: onBench }, 'Invented.', stamp(1))?.about).toEqual({ kind: 'exercise', key: 'push', slotId: 'a1', liftId: 'bench-press', label: 'Bench press' });
    expect(noteOf({ kind: 'exercise', day: PUSH, exercise: calves }, 'Invented.', stamp(1))?.about).toEqual({ kind: 'exercise', key: 'push', liftId: 'calf-raise', label: 'Calf raise' });
  });
});

describe('TrainingNote', () => {
  const line = { id: '0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c', date: '2030-03-04', text: 'Invented line.', at: T0 };

  it('holds a line of text for a date, with no about as an older build wrote it', () => {
    expect(TrainingNote.safeParse(line).success).toBe(true);
    expect(TrainingNote.safeParse({ ...line, text: '' }).success).toBe(false);
    expect(TrainingNote.safeParse({ ...line, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('round-trips what a line is about, and what a newer build adds to it', () => {
    const about = { kind: 'exercise', key: 'push', liftId: 'calf-raise', label: 'Calf raise', fromNewerApp: 1 };
    expect(TrainingNote.parse({ ...line, about }).about).toEqual(about);
  });
});

describe('notesOn', () => {
  const doc = (n: number, target: Parameters<typeof noteOf>[0], text: string) => {
    const note = noteOf(target, text, stamp(n));
    if (note === null) throw new Error('blank');
    return note;
  };
  const dayTarget: DayNoteTarget = { kind: 'day', day: PUSH, label: 'Push' };
  const benchTarget: DayNoteTarget = { kind: 'exercise', day: PUSH, exercise: onBench };
  const texts = (target: DayNoteTarget, logs: Parameters<typeof notesOn>[1]) => notesOn(target, logs).map((line) => line.text);
  const pushed = session({ note: 'Invented older day line.' });

  it('lists an older build\'s line first, then documents by time, and none of another day on that date', () => {
    const pullDay = { kind: 'day' as const, day: { key: dayKey('pull'), date: DATE }, label: 'Pull' };
    const notes = [doc(3, dayTarget, 'Invented third.'), doc(1, dayTarget, 'Invented first.'), doc(2, pullDay, 'Invented pull line.'), doc(4, { kind: 'week', date: DATE }, 'Invented week line.')];
    expect(texts(dayTarget, { notes, session: pushed, performances: [] })).toEqual(['Invented older day line.', 'Invented first.', 'Invented third.']);
    expect(notesOn(dayTarget, { notes, session: pushed, performances: [] })[0]?.ref).toEqual({ kind: 'session', id: pushed.id });
  });

  it('matches an exercise line the way its sets are, across a swap, and keeps an added one apart', () => {
    const swapped = { ...onBench, lift: { liftId: lift('machine-press'), label: 'Machine press' } };
    const notes = [doc(1, { kind: 'exercise', day: PUSH, exercise: swapped }, 'Invented on the swap.'), doc(2, { kind: 'exercise', day: PUSH, exercise: calves }, 'Invented on calves.')];
    const olderOnBench = performance({ session: pushed.id, slot: 'a1', lift: 'bench-press', note: 'Invented older exercise line.', sets: [lb(100, 8)] });
    expect(texts(benchTarget, { notes, session: pushed, performances: [olderOnBench] })).toEqual(['Invented older exercise line.', 'Invented on the swap.']);
    expect(texts({ kind: 'exercise', day: PUSH, exercise: calves }, { notes, session: pushed, performances: [olderOnBench] })).toEqual(['Invented on calves.']);
    expect(texts(dayTarget, { notes, session: null, performances: [olderOnBench] })).toEqual([]);
  });
});
