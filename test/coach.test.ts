import { describe, expect, it } from 'vitest';
import { changeWords } from '../src/client/screens/format.js';
import { checkPublish, coachWeek, parseProgramDraft, programDiff, sameContent, snapshotOf, targetMondayOf, type DiffItem, type DiffKind, type PublishVerdict, type TrainDocs } from '../src/domain/coach.js';
import { makeWorkout, metDraft } from '../src/domain/burn.js';
import type { Entry } from '../src/domain/diary.js';
import { TrainingNoteId, WorkoutId, type LocalDate } from '../src/domain/ids.js';
import { Lift, Target } from '../src/domain/lifts.js';
import { CardioBlock, ChecklistBlock, Day, LiftsBlock, ProgramDraft, ProgramNote, Slot, StandingText, SwapOption, type Block, type Program } from '../src/domain/program.js';
import { entry, newEntryId, weighIn } from './fixtures.js';
import { T0, blockId, bw, cardio, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, pinned, program, session, slot, slotId, target, warm } from './training.fixtures.js';

const benchSlot = slot('a1', 'bench-press', 3, { cue: 'Pause on the chest.', swaps: [{ liftId: lift('incline-press'), label: 'Incline press', cue: 'Elbows in.' }] });
const rowSlot = slot('a2', 'cable-row', 3);
const pushBlock = liftsBlock('main', [benchSlot, rowSlot], { title: 'Main' });
const abBlock = liftsBlock('abs', [slot('c1', 'crunch', 2, { target: target(2, 10, 15, { load: 'bodyweight' }) })], { title: 'Abs' });
const standing = [{ key: 'rules', title: 'Rules', text: 'Stop two reps short.' }];

const DAYS = [
  { key: 'push', blocks: [pushBlock, abBlock] },
  { key: 'legs', blocks: [liftsBlock('legs', [slot('b1', 'squat', 3)])] },
];
const base = program('2030-03-04', DAYS, { standing });

const AT = { today: day('2030-03-08'), now: ms(T0) };

/** The same plan as a draft for another date, ready to be broken one thing at a time. */
function draftOf(version: Program, effectiveFrom: string, edit: (draft: ProgramDraft) => ProgramDraft = (d) => d): ProgramDraft {
  const { id: _id, publishedAt: _publishedAt, ...rest } = version;
  return edit({ ...rest, effectiveFrom: day(effectiveFrom) });
}

function withDay(draft: ProgramDraft, key: string, blocks: readonly Block[]): ProgramDraft {
  return { ...draft, days: draft.days.map((d) => (d.key === key ? { ...d, blocks: [...blocks] } : d)) };
}

const onlySlots = (...slots: Slot[]) => [liftsBlock('main', slots, { title: 'Main' }), abBlock];
const diffOf = (edit: (draft: ProgramDraft) => ProgramDraft) => programDiff(base, draftOf(base, '2030-03-11', edit));
const kinds = (items: readonly DiffItem[]) => items.map((item) => [item.kind, item.target]);

function problemsOf(verdict: PublishVerdict) {
  if (verdict.status !== 'invalid' && verdict.status !== 'frozen') throw new Error(`no problems: ${verdict.status}`);
  return verdict.problems;
}
const codes = (verdict: PublishVerdict) => problemsOf(verdict).map((p) => p.code);

describe('programDiff', () => {
  it('finds nothing between a version and itself, or before any version', () => {
    expect(diffOf((d) => d)).toEqual([]);
    expect(programDiff(null, draftOf(base, '2030-03-11'))).toEqual([]);
  });

  it('lists a removed day alone, because one reason covers what was inside it', () => {
    const items = diffOf((d) => ({ ...d, days: d.days.filter((x) => x.key !== 'legs') }));
    expect(kinds(items)).toEqual([['day-removed', 'day:legs']]);
    expect(items[0]?.needsReason).toBe(true);
  });

  it('lists a removed block alone', () => {
    expect(kinds(diffOf((d) => withDay(d, 'push', [pushBlock])))).toEqual([['block-removed', 'block:push/abs']]);
  });

  it('lists a removed slot with its prescription', () => {
    const items = diffOf((d) => withDay(d, 'push', onlySlots(benchSlot)));
    expect(kinds(items)).toEqual([['slot-removed', 'slot:push/a2']]);
    expect(items[0]?.before).toBe('cable-row 3 x 8-10');
  });

  it('does not read a slot moved between blocks as removed', () => {
    const moved = withDay(draftOf(base, '2030-03-11'), 'push', [liftsBlock('main', [benchSlot], { title: 'Main' }), liftsBlock('abs', [rowSlot, ...abBlock.slots], { title: 'Abs' })]);
    expect(programDiff(base, moved)).toEqual([{ kind: 'slot-moved', target: 'slot:push/a2', label: 'Day push / cable-row', before: 'Main', after: 'Abs', needsReason: false, why: null }]);
  });

  it('lists a removed or emptied cue, on a slot and on a swap', () => {
    const { cue: _cue, ...noCue } = benchSlot;
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noCue, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1']]);
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots({ ...benchSlot, cue: '  ' }, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1']]);
    const noSwapCue = { ...benchSlot, swaps: [{ liftId: lift('incline-press'), label: 'Incline press' }] };
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noSwapCue, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1/incline-press']]);
    const { swaps: _swaps, ...noSwaps } = benchSlot;
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noSwaps, rowSlot))))).toEqual([
      ['swaps-removed', 'swaps:push/a1'],
      ['cue-removed', 'cue:push/a1/incline-press'],
    ]);
  });

  it('shows an edited or new cue with no reason needed', () => {
    const edited = diffOf((d) => withDay(d, 'push', onlySlots({ ...benchSlot, cue: 'Pause longer.' }, { ...rowSlot, cue: 'Squeeze.' })));
    expect(edited).toEqual([
      { kind: 'cue-edited', target: 'cue:push/a1', label: 'Day push / bench-press', before: 'Pause on the chest.', after: 'Pause longer.', needsReason: false, why: null },
      { kind: 'cue-added', target: 'cue:push/a2', label: 'Day push / cable-row', before: null, after: 'Squeeze.', needsReason: false, why: null },
    ]);
  });

  it('lists removed or emptied standing text, and shows an edit with no reason needed', () => {
    expect(kinds(diffOf((d) => ({ ...d, standing: [] })))).toEqual([['standing-removed', 'standing:rules']]);
    expect(kinds(diffOf((d) => ({ ...d, standing: [{ key: 'rules', title: 'Rules', text: '' }] })))).toEqual([['standing-removed', 'standing:rules']]);
    const edited = diffOf((d) => ({ ...d, standing: [{ key: 'rules', title: 'Rules', text: 'Stop one rep short.' }] }));
    expect(edited.map((i) => [i.kind, i.needsReason])).toEqual([['standing-edited', false]]);
  });

  it.each<[string, Partial<Slot>, string]>([
    ['sets', { target: target(4, 8, 10) }, 'bench-press 4 x 8-10'],
    ['the range', { target: target(3, 10, 12) }, 'bench-press 3 x 10-12'],
    ['a fixed count', { target: target(3, 10, 10) }, 'bench-press 3 x 10'],
    ['per side', { target: target(3, 8, 10, { perSide: 'left-first' }) }, 'bench-press 3 x 8-10 per side'],
    ['per side with no starting side', { target: target(3, 8, 10, { perSide: 'either' }) }, 'bench-press 3 x 8-10 per side'],
    ['the load', { target: target(3, 8, 10, { load: 'band' }) }, 'bench-press 3 x 8-10 band'],
    ['the lift', { liftId: lift('incline-press') }, 'incline-press 3 x 8-10'],
  ])('lists a changed prescription: %s', (_name, change, after) => {
    const items = diffOf((d) => withDay(d, 'push', onlySlots({ ...benchSlot, ...change }, rowSlot)));
    expect(items).toEqual([{ kind: 'prescription-changed', target: 'prescription:push/a1', label: 'Day push / bench-press', before: 'bench-press 3 x 8-10', after, needsReason: true, why: null }]);
  });

  it('shows a rename and additions with no reason needed', () => {
    const added = slot('a3', 'face-pull', 2);
    const items = diffOf((d) => {
      const edited = withDay(d, 'push', [...onlySlots({ ...benchSlot, label: 'Paused bench' }, rowSlot, added), checklist('warm')]);
      return { ...edited, days: [...edited.days, { key: dayKey('arms'), label: 'Arms', blocks: [checklist('curls')] }], standing: [...d.standing, { key: 'sleep', title: 'Sleep', text: 'Eight hours.' }] };
    });
    expect(items.map((i) => [i.kind, i.target, i.needsReason])).toEqual([
      ['block-added', 'block:push/warm', false],
      ['slot-renamed', 'slot:push/a1', false],
      ['slot-added', 'slot:push/a3', false],
      ['day-added', 'day:arms', false],
      ['standing-added', 'standing:sleep', false],
    ]);
  });

  it('does not call a one-week block a loss once its week is before the new version', () => {
    const before = program('2030-03-04', [{ key: 'push', blocks: [pushBlock, liftsBlock('retest', [slot('r1', 'squat', 1)], { onlyWeek: day('2030-03-04') })] }, { key: 'once', blocks: [checklist('intro', { onlyWeek: day('2030-03-04') })] }]);
    const after = draftOf(program('2030-03-04', [{ key: 'push', blocks: [pushBlock] }]), '2030-03-11');
    expect(programDiff(before, after)).toEqual([]);
  });

  it('does call it a loss when its week is still ahead', () => {
    const before = program('2030-03-04', [{ key: 'push', blocks: [pushBlock, liftsBlock('retest', [slot('r1', 'squat', 1)], { onlyWeek: day('2030-03-11') })] }]);
    const after = draftOf(program('2030-03-04', [{ key: 'push', blocks: [pushBlock] }]), '2030-03-11');
    expect(kinds(programDiff(before, after))).toEqual([['block-removed', 'block:push/retest']]);
  });

  describe('every field of the plan', () => {
    const inclineSwap = { liftId: lift('incline-press'), label: 'Incline press' };
    const deckSwap = { liftId: lift('pec-deck'), label: 'Pec deck' };
    const first = slot('a1', 'bench-press', 3, { cue: 'Slow down.', setPrompt: 'Which bar?', swaps: [inclineSwap, deckSwap] });
    const second = slot('a2', 'cable-row', 3, { swaps: [deckSwap], target: target(3, 8, 10, { perSide: 'left-first', load: 'band' }) });
    const main = liftsBlock('main', [first, second], { title: 'Main', note: 'Go slow.', restSeconds: 60 });
    const warmUp = checklist('warm', { title: 'Warm up', items: ['Jumping jacks', 'Light row'] });
    const swim = cardio('swim', { title: 'Swim', optional: true });
    const later = checklist('later', { title: 'Later', onlyWeek: day('2030-03-18') });
    const lifts: Lift[] = [{ id: lift('bench-press'), name: 'Bench press', aliases: [] }, { id: lift('cable-row'), name: 'Cable row', aliases: [lift('seated-row')], key: true }, { id: lift('incline-press'), name: 'Incline press', aliases: [] }, { id: lift('pec-deck'), name: 'Pec deck', aliases: [] }];
    const weekNote = { title: 'Focus', text: 'Go slow.' };
    const laterNote = { text: 'Next week is light.', onlyWeek: day('2030-03-18') };
    const dayNote = { text: 'Bring chalk.', day: dayKey('push') };
    const full = program('2030-03-04', [{ key: 'push', label: 'Push', weekday: 1, minutes: 60, blocks: [main, warmUp, swim, later] }], { weeklyMinimum: 3, standing, lifts, notes: [weekNote, laterNote, dayNote] });

    type Edit = (draft: ProgramDraft) => ProgramDraft;
    const onDay = (change: Partial<Day>): Edit => (d) => ({ ...d, days: d.days.map((x) => ({ ...x, ...change })) });
    const onBlock = (id: string, change: { readonly title?: string | undefined; readonly note?: string | undefined; readonly optional?: true | undefined; readonly onlyWeek?: LocalDate | undefined; readonly restSeconds?: number | undefined; readonly items?: string[]; readonly slots?: Slot[] }): Edit => (d) => ({ ...d, days: d.days.map((x) => ({ ...x, blocks: x.blocks.map((b) => (b.id === id ? { ...b, ...change } : b)) })) });
    const onSlot = (edited: Slot): Edit => onBlock('main', { slots: main.slots.map((s) => (s.id === edited.id ? edited : s)) });
    const onLift = (id: string, change: Partial<Lift>): Edit => (d) => ({ ...d, lifts: d.lifts.map((l) => (l.id === id ? { ...l, ...change } : l)) });
    const withNotes = (...notes: ProgramNote[]): Edit => (d) => ({ ...d, notes });

    const FIELDS: readonly [field: string, edit: Edit, kind: DiffKind, target: string, needsReason: boolean, words: string][] = [
      ['Program.weeklyMinimum', (d) => ({ ...d, weeklyMinimum: 4 }), 'minimum-changed', 'weekly-minimum', false, 'Weekly minimum is now 4'],
      ['Program.weeklyMinimum cleared', (d) => ({ ...d, weeklyMinimum: undefined }), 'minimum-changed', 'weekly-minimum', false, 'Weekly minimum is gone'],
      ['Program.days', (d) => ({ ...d, days: [...d.days, { key: dayKey('arms'), label: 'Arms', blocks: [warmUp] }] }), 'day-added', 'day:arms', false, 'Arms is new'],
      ['Program.lifts', onLift('bench-press', { key: true }), 'lift-key-changed', 'lift:bench-press', false, 'Bench press is now a key lift'],
      ['Program.notes', withNotes(weekNote, laterNote, dayNote, { text: 'Bring water.' }), 'note-added', 'note:week/3', false, 'A new note on the week'],
      ['Program.standing', (d) => ({ ...d, standing: [] }), 'standing-removed', 'standing:rules', true, 'Rules left the program'],
      ['Day.label', onDay({ label: 'Upper' }), 'day-renamed', 'day:push', false, 'Push is now called Upper'],
      ['Day.weekday', onDay({ weekday: 2 }), 'day-weekday-changed', 'weekday:push', false, 'Push moved to Tue'],
      ['Day.weekday cleared', onDay({ weekday: undefined }), 'day-weekday-changed', 'weekday:push', false, 'Push has no set day'],
      ['Day.minutes', onDay({ minutes: 45 }), 'day-minutes-changed', 'minutes:push', false, 'Push is now 45 min'],
      ['Day.minutes cleared', onDay({ minutes: undefined }), 'day-minutes-changed', 'minutes:push', false, 'Push has no set length'],
      ['Day.blocks', onDay({ blocks: [main, swim, later] }), 'block-removed', 'block:push/warm', true, 'Push / Warm up is gone'],
      ['Block.title', onBlock('main', { title: 'Core' }), 'block-renamed', 'block:push/main', false, 'Push / Main is now called Core'],
      ['Block.title cleared', onBlock('main', { title: undefined }), 'block-renamed', 'block:push/main', false, 'Push / Main is now called main'],
      ['Block.note', onBlock('main', { note: 'Go slower.' }), 'block-note-edited', 'block-note:push/main', false, 'The note on Push / Main changed'],
      ['Block.note added', onBlock('warm', { note: 'Take your time.' }), 'block-note-added', 'block-note:push/warm', false, 'Push / Warm up has a new note'],
      ['Block.note emptied', onBlock('main', { note: '  ' }), 'block-note-removed', 'block-note:push/main', true, 'The note on Push / Main is gone'],
      ['Block.note removed', onBlock('main', { note: undefined }), 'block-note-removed', 'block-note:push/main', true, 'The note on Push / Main is gone'],
      ['Block.optional', onBlock('main', { optional: true }), 'block-optional-changed', 'optional:push/main', false, 'Push / Main is now optional'],
      ['Block.optional cleared', onBlock('swim', { optional: undefined }), 'block-optional-changed', 'optional:push/swim', false, 'Push / Swim is now required'],
      ['Block.onlyWeek', onBlock('main', { onlyWeek: day('2030-03-11') }), 'one-week', 'only-week:push/main', true, 'Push / Main is now one week only'],
      ['Block.onlyWeek cleared', onBlock('later', { onlyWeek: undefined }), 'every-week', 'only-week:push/later', false, 'Push / Later is now every week'],
      ['Block.restSeconds', onBlock('main', { restSeconds: 90 }), 'block-rest-changed', 'rest:push/main', false, 'Rest on Push / Main is now 90s'],
      ['Block.restSeconds cleared', onBlock('main', { restSeconds: undefined }), 'block-rest-changed', 'rest:push/main', false, 'Push / Main has no set rest'],
      ['Block.items', onBlock('warm', { items: ['Jumping jacks'] }), 'checklist-edited', 'moves:push/warm', false, 'The moves in Push / Warm up changed'],
      ['Block.slots', onBlock('main', { slots: [first] }), 'slot-removed', 'slot:push/a2', true, 'Push / cable-row is gone'],
      ['Slot.liftId', onSlot({ ...first, liftId: lift('incline-press') }), 'prescription-changed', 'prescription:push/a1', true, 'Push / bench-press went from bench-press 3 x 8-10 to incline-press 3 x 8-10'],
      ['Slot.label', onSlot({ ...first, label: 'Paused bench' }), 'slot-renamed', 'slot:push/a1', false, 'Push / bench-press is now called Paused bench'],
      ['Slot.target', onSlot({ ...first, target: target(4, 8, 10) }), 'prescription-changed', 'prescription:push/a1', true, 'Push / bench-press went from 3 x 8-10 to 4 x 8-10'],
      ['Slot.cue', onSlot({ ...first, cue: 'Slower.' }), 'cue-edited', 'cue:push/a1', false, 'The cue on Push / bench-press changed'],
      ['Slot.setPrompt', onSlot({ ...first, setPrompt: 'Which grip?' }), 'set-note-edited', 'set-note:push/a1', false, 'The set note on Push / bench-press changed'],
      ['Slot.setPrompt added', onSlot({ ...second, setPrompt: 'Which grip?' }), 'set-note-added', 'set-note:push/a2', false, 'Push / cable-row asks for a set note'],
      ['Slot.setPrompt removed', onSlot({ ...first, setPrompt: undefined }), 'set-note-removed', 'set-note:push/a1', true, 'The set note on Push / bench-press is gone'],
      ['Slot.swaps', onSlot({ ...first, swaps: [inclineSwap] }), 'swaps-edited', 'swaps:push/a1', false, 'The swaps on Push / bench-press changed'],
      ['Slot.swaps emptied', onSlot({ ...second, swaps: [] }), 'swaps-removed', 'swaps:push/a2', true, 'The swaps on Push / cable-row are gone'],
      ['Slot.swaps removed', onSlot({ ...second, swaps: undefined }), 'swaps-removed', 'swaps:push/a2', true, 'The swaps on Push / cable-row are gone'],
      ['SwapOption.liftId', onSlot({ ...second, swaps: [{ ...deckSwap, liftId: lift('incline-press') }] }), 'swaps-edited', 'swaps:push/a2', false, 'The swaps on Push / cable-row changed'],
      ['SwapOption.label', onSlot({ ...second, swaps: [{ ...deckSwap, label: 'Flyes' }] }), 'swaps-edited', 'swaps:push/a2', false, 'The swaps on Push / cable-row changed'],
      ['SwapOption.cue', onSlot({ ...second, swaps: [{ ...deckSwap, cue: 'Slower.' }] }), 'cue-added', 'cue:push/a2/pec-deck', false, 'Push / cable-row / pec-deck has a new cue'],
      ['Target.sets', onSlot({ ...second, target: { ...second.target, sets: 4 } }), 'prescription-changed', 'prescription:push/a2', true, 'Push / cable-row went from 3 x 8-10 per side band to 4 x 8-10 per side band'],
      ['Target.reps', onSlot({ ...second, target: { ...second.target, reps: { min: 6, max: 8 } } }), 'prescription-changed', 'prescription:push/a2', true, 'Push / cable-row went from 3 x 8-10 per side band to 3 x 6-8 per side band'],
      ['Target.load', onSlot({ ...second, target: { ...second.target, load: 'bodyweight' } }), 'prescription-changed', 'prescription:push/a2', true, 'Push / cable-row went from 3 x 8-10 per side band to 3 x 8-10 per side bodyweight'],
      ['Target.perSide', onSlot({ ...second, target: { ...second.target, perSide: 'right-first' } }), 'side-changed', 'side:push/a2', false, 'Push / cable-row now goes right first'],
      ['Target.perSide with none named', onSlot({ ...second, target: { ...second.target, perSide: 'either' } }), 'side-changed', 'side:push/a2', false, 'Push / cable-row now goes either side first'],
      ['Target.perSide cleared', onSlot({ ...second, target: { ...second.target, perSide: undefined } }), 'prescription-changed', 'prescription:push/a2', true, 'Push / cable-row went from 3 x 8-10 per side band to 3 x 8-10 band'],
      ['ProgramNote.text', withNotes({ ...weekNote, text: 'Go slower.' }, laterNote, dayNote), 'note-edited', 'note:week/2', false, 'A note on the week changed'],
      ['ProgramNote.text on a day', withNotes(weekNote, laterNote, { ...dayNote, text: 'Bring a towel.' }), 'note-edited', 'note:push/1', false, 'A note on Push changed'],
      ['ProgramNote.title', withNotes({ ...weekNote, title: 'Tempo' }, laterNote, dayNote), 'note-edited', 'note:week/2', false, 'A note on the week changed'],
      ['ProgramNote.onlyWeek', withNotes({ ...weekNote, onlyWeek: day('2030-03-11') }, laterNote, dayNote), 'one-week', 'only-week:note:week/1', true, 'A note on the week is now one week only'],
      ['ProgramNote.onlyWeek cleared', withNotes(weekNote, { text: laterNote.text }, dayNote), 'every-week', 'only-week:note:week/2', false, 'A note on the week is now every week'],
      ['ProgramNote.text gone', withNotes(laterNote, dayNote), 'note-removed', 'note:week/2', true, 'A note on the week is gone'],
      ['StandingText.title', (d) => ({ ...d, standing: [{ key: 'rules', title: 'House rules', text: 'Stop two reps short.' }] }), 'standing-renamed', 'standing:rules', false, 'Rules is now called House rules'],
      ['StandingText.text', (d) => ({ ...d, standing: [{ key: 'rules', title: 'Rules', text: 'Stop one rep short.' }] }), 'standing-edited', 'standing:rules', false, 'Rules changed in the program'],
      ['Lift.name', onLift('bench-press', { name: 'Flat bench' }), 'lift-renamed', 'lift:bench-press', false, 'Bench press is now called Flat bench'],
      ['Lift.aliases', onLift('bench-press', { aliases: [lift('barbell-bench')] }), 'lift-aliases-changed', 'lift:bench-press', false, 'The other names for Bench press changed'],
      ['Lift.key', onLift('cable-row', { key: undefined }), 'lift-key-changed', 'lift:cable-row', false, 'Cable row left the key lifts'],
    ];

    /** Fields with no row: the version's own date and words, and ids, where a new one reads as removed and added. */
    const LEFT_OUT = ['Program.effectiveFrom', 'Program.report', 'Program.changes', 'Day.key', 'Block.id', 'Block.kind', 'Slot.id', 'ProgramNote.day', 'StandingText.key', 'Lift.id'];

    it('has a row for each, or says why not, so a new field cannot slip past the diff', () => {
      const fieldsOf = (name: string, ...schemas: readonly { readonly shape: object }[]) => schemas.flatMap((schema) => Object.keys(schema.shape).map((field) => `${name}.${field}`));
      const schema = [
        ...fieldsOf('Program', ProgramDraft),
        ...fieldsOf('Day', Day),
        ...fieldsOf('Block', LiftsBlock, ChecklistBlock, CardioBlock),
        ...fieldsOf('Slot', Slot),
        ...fieldsOf('SwapOption', SwapOption),
        ...fieldsOf('Target', Target),
        ...fieldsOf('ProgramNote', ProgramNote),
        ...fieldsOf('StandingText', StandingText),
        ...fieldsOf('Lift', Lift),
      ];
      const covered = [...FIELDS.map(([field]) => field.split(' ')[0] ?? ''), ...LEFT_OUT];
      expect([...new Set(schema)].filter((field) => !covered.includes(field))).toEqual([]);
      expect([...new Set(covered)].filter((field) => !schema.includes(field))).toEqual([]);
    });

    it.each(FIELDS)('lists %s, in words the phone can show', (_field, edit, kind, changeTarget, needsReason, words) => {
      const items = programDiff(full, draftOf(full, '2030-03-11', edit));
      expect(items.map((item) => [item.kind, item.target, item.needsReason])).toEqual([[kind, changeTarget, needsReason]]);
      expect(items.map(changeWords)).toEqual([words]);
    });

    it('never puts a note\'s words on the phone, so a day\'s or a later week\'s does not show early', () => {
      const items = programDiff(full, draftOf(full, '2030-03-11', withNotes(weekNote, laterNote, dayNote, { text: 'Invented next week.', onlyWeek: day('2030-03-18') })));
      expect(items.map((item) => item.after)).toEqual(['Invented next week.']);
      expect(items.map(changeWords)).toEqual(['A new note on the week']);
    });

    it('reads a shorter list of notes as a loss, however the rest were edited', () => {
      const items = programDiff(full, draftOf(full, '2030-03-11', withNotes({ text: 'Only this now.' }, dayNote)));
      expect(items.map((item) => [item.kind, item.before, item.after])).toEqual([
        ['note-edited', 'Focus: Go slow.', 'Only this now.'],
        ['note-removed', 'Next week is light.', null],
      ]);
    });

    it('reads a note moved to another day as one gone and one new', () => {
      const items = programDiff(full, draftOf(full, '2030-03-11', withNotes(weekNote, laterNote, { text: dayNote.text })));
      expect(kinds(items)).toEqual([
        ['note-added', 'note:week/3'],
        ['note-removed', 'note:push/1'],
      ]);
    });

    it('does not call a one-week note a loss once its week is before the new version', () => {
      expect(programDiff(full, draftOf(full, '2030-03-25', withNotes(weekNote, dayNote)))).toEqual([]);
    });

    it('reads a block changing kind under one id as one gone and one new, with one reason for its slots', () => {
      const edit: Edit = (d) => ({ ...d, days: d.days.map((x) => ({ ...x, blocks: [checklist('main', { title: 'Main' }), warmUp, swim, later] })) });
      expect(kinds(programDiff(full, draftOf(full, '2030-03-11', edit)))).toEqual([
        ['block-removed', 'block:push/main'],
        ['block-added', 'block:push/main'],
      ]);
    });

    it('leaves out a new lift, which shows through the slot naming it, unless it joins histories or the board', () => {
      const added = (extra: Partial<Lift>): Edit => (d) => ({ ...d, lifts: [...d.lifts, { id: lift('landmine-press'), name: 'Landmine press', aliases: [], ...extra }] });
      expect(programDiff(full, draftOf(full, '2030-03-11', added({})))).toEqual([]);
      expect(kinds(programDiff(full, draftOf(full, '2030-03-11', added({ aliases: [lift('landmine')] }))))).toEqual([['lift-aliases-changed', 'lift:landmine-press']]);
      expect(kinds(programDiff(full, draftOf(full, '2030-03-11', added({ key: true }))))).toEqual([['lift-key-changed', 'lift:landmine-press']]);
    });

    it('does not read reordered aliases, or a key flag set false, as a change', () => {
      const aliased = program('2030-03-04', [{ key: 'push', blocks: [main] }], { lifts: [{ id: lift('squat'), name: 'Squat', aliases: [lift('a'), lift('b')] }] });
      const edit: Edit = (d) => ({ ...d, lifts: [{ id: lift('squat'), name: 'Squat', aliases: [lift('b'), lift('a')], key: false }] });
      expect(programDiff(aliased, draftOf(aliased, '2030-03-11', edit))).toEqual([]);
    });
  });

  it('carries the reason from changes, as plain data the phone can render', () => {
    const items = diffOf((d) => ({ ...withDay(d, 'push', onlySlots(benchSlot)), changes: [{ target: 'slot:push/a2', why: 'The machine is gone.' }] }));
    expect(items[0]?.why).toBe('The machine is gone.');
    expect(JSON.parse(JSON.stringify(items))).toEqual(items);
  });
});

describe('sameContent', () => {
  it('ignores the stamp and key order, and sees any real change', () => {
    const reversedKeys = ProgramDraft.parse(Object.fromEntries(Object.entries(draftOf(base, '2030-03-04')).toReversed()));
    expect(sameContent(base, { ...base, publishedAt: ms(T0 + 1) })).toBe(true);
    expect(sameContent(base, reversedKeys)).toBe(true);
    expect(sameContent(base, { ...base, weeklyMinimum: 3 })).toBe(false);
    expect(sameContent(base, withDay(base, 'push', [pushBlock]))).toBe(false);
  });
});

describe('parseProgramDraft', () => {
  const clean = draftOf(base, '2030-03-11');

  it.each<[string, ProgramDraft, string]>([
    ['at the top', { ...clean, weeklyMinimun: 3 }, 'weeklyMinimun'],
    ['in a slot', withDay(clean, 'push', onlySlots({ ...benchSlot, cuue: 'typo' }, rowSlot)), 'days[0].blocks[0].slots[0].cuue'],
    ['in a target', withDay(clean, 'push', onlySlots({ ...benchSlot, target: { ...benchSlot.target, setz: 3 } }, rowSlot)), 'days[0].blocks[0].slots[0].target.setz'],
    ['in a range', withDay(clean, 'push', onlySlots({ ...benchSlot, target: { sets: 3, reps: { min: 8, max: 10, mx: 1 } } }, rowSlot)), 'days[0].blocks[0].slots[0].target.reps.mx'],
    ['in a swap', withDay(clean, 'push', onlySlots({ ...benchSlot, swaps: [{ liftId: lift('incline-press'), label: 'x', que: 'y' }] }, rowSlot)), 'days[0].blocks[0].slots[0].swaps[0].que'],
    ['in a checklist', withDay(clean, 'push', [{ ...checklist('warm'), itemz: [] }]), 'days[0].blocks[0].itemz'],
    ['in the catalog', { ...clean, lifts: [{ id: lift('squat'), name: 'Squat', aliases: [], keylift: true }] }, 'lifts[0].keylift'],
  ])('refuses a misspelled field %s, naming it', (_where, draft, path) => {
    const parsed = parseProgramDraft(draft);
    if (parsed.ok) throw new Error('expected a refusal');
    expect(parsed.problems).toContainEqual({ code: 'unknown-field', path, message: 'no such field' });
  });

  it('refuses a field that survives on a stored version, because the tool stamps them', () => {
    expect(parseProgramDraft(base).ok).toBe(false);
  });

  it('reports a stray field and a broken field together', () => {
    const parsed = parseProgramDraft({ ...clean, stray: 1, effectiveFrom: 'soon' });
    if (parsed.ok) throw new Error('expected a refusal');
    expect(parsed.problems.map((p) => [p.code, p.path])).toEqual([
      ['unknown-field', 'stray'],
      ['shape', 'effectiveFrom'],
    ]);
  });

  it('does not treat a field named like an object method as known', () => {
    expect(parseProgramDraft({ ...clean, constructor: 'x' }).ok).toBe(false);
  });

  it('accepts a clean draft', () => {
    expect(parseProgramDraft(clean).ok).toBe(true);
  });

  it('refuses something that is not a draft at all', () => {
    expect(parseProgramDraft(null).ok).toBe(false);
    expect(parseProgramDraft([]).ok).toBe(false);
  });
});

describe('coachWeek', () => {
  it('leaves week notes out of what the phone lists as changed', () => {
    const pushDay = { key: 'push', blocks: [liftsBlock('main', [slot('a1', 'bench-press', 3)])] };
    const before = program('2030-03-04', [pushDay], { notes: [{ text: 'An old reminder.' }] });
    const after = program('2030-03-11', [pushDay, { key: 'pull', blocks: [liftsBlock('other', [slot('b1', 'seal-row', 3)])] }]);
    const week = coachWeek(before, [after]);
    expect(week.kind === 'checked-in' ? week.changes.map((item) => item.target) : []).toEqual(['day:pull']);
    expect(programDiff(before, after).some((item) => item.kind.startsWith('note-'))).toBe(true);
  });

  const reported = (text: string, at: number) => ({ report: { text }, publishedAt: ms(at) });
  const week = program('2030-03-11', DAYS, { ...reported('A good week.', T0), standing: [], changes: [{ target: 'standing:rules', why: 'Said elsewhere now.' }] });

  it('is quiet with no version this week, whatever came before', () => {
    expect(coachWeek(base, [])).toEqual({ kind: 'quiet' });
    expect(coachWeek(null, [])).toEqual({ kind: 'quiet' });
  });

  it('shows the report and the publish time, with what changed and why', () => {
    const shown = coachWeek(base, [week]);
    expect(shown).toMatchObject({ kind: 'checked-in', at: T0, report: { text: 'A good week.' } });
    expect(shown.kind === 'checked-in' ? shown.changes.map((c) => [c.target, c.why]) : []).toEqual([['standing:rules', 'Said elsewhere now.']]);
  });

  it('shows no changes for a first version', () => {
    expect(coachWeek(null, [week])).toMatchObject({ kind: 'checked-in', changes: [] });
  });

  it('keeps the week\'s report and its changes when a version follows it mid-week with no report', () => {
    const fix = program('2030-03-13', DAYS.slice(0, 1), { publishedAt: ms(T0 + 1000), changes: [{ target: 'day:legs', why: 'Moved to a later week.' }] });
    const shown = coachWeek(base, [week, fix]);
    expect(shown).toMatchObject({ kind: 'checked-in', at: T0, report: { text: 'A good week.' } });
    expect(shown.kind === 'checked-in' ? shown.changes.map((c) => c.why) : []).toEqual(['Said elsewhere now.', 'Moved to a later week.']);
  });

  it('names the newest version\'s time when no version this week brought a report', () => {
    const later = program('2030-03-11', DAYS, { publishedAt: ms(T0 + 5) });
    expect(coachWeek(base, [later])).toMatchObject({ kind: 'checked-in', at: T0 + 5, report: null });
  });
});

describe('checkPublish', () => {
  const versions = [base];
  const check = (edit: (draft: ProgramDraft) => ProgramDraft, date = '2030-03-11') => checkPublish(draftOf(base, date, edit), versions, AT);

  it('stamps a valid draft with its id and time, and carries the diff', () => {
    const verdict = check((d) => withDay(d, 'push', onlySlots({ ...benchSlot, cue: 'Pause longer.' }, rowSlot)));
    if (verdict.status !== 'valid') throw new Error(verdict.status);
    expect(verdict.program.id).toBe('p:2030-03-11');
    expect(verdict.program.publishedAt).toBe(T0);
    expect(verdict.diff.map((i) => i.kind)).toEqual(['cue-edited']);
  });

  describe('silent drops', () => {
    const { cue: _cue, ...noCue } = benchSlot;

    it('refuses a dropped slot and a dropped cue, naming each', () => {
      const problems = problemsOf(check((d) => withDay(d, 'push', onlySlots(noCue))));
      expect(problems.map((p) => p.code)).toEqual(['unexplained', 'unexplained']);
      expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('"cue:push/a1"'), expect.stringContaining('"slot:push/a2"')]);
    });

    it('lets them through once changes names them', () => {
      const verdict = check((d) => ({
        ...withDay(d, 'push', onlySlots(noCue)),
        changes: [
          { target: 'cue:push/a1', why: 'He has this down.' },
          { target: 'slot:push/a2', why: 'Moved to pull day.' },
        ],
      }));
      expect(verdict.status).toBe('valid');
    });

    it('still refuses when only one of them is named, and refuses a blank reason at the schema', () => {
      const partly = check((d) => ({ ...withDay(d, 'push', onlySlots(noCue)), changes: [{ target: 'cue:push/a1', why: 'He has this down.' }] }));
      expect(problemsOf(partly).map((p) => p.message)).toEqual([expect.stringContaining('"slot:push/a2"')]);
      const blank = check((d) => ({ ...withDay(d, 'push', onlySlots(noCue, rowSlot)), changes: [{ target: 'cue:push/a1', why: '  ' }] }));
      expect(codes(blank)).toEqual(['shape']);
    });

    it('refuses a changed prescription with no reason', () => {
      expect(codes(check((d) => withDay(d, 'push', onlySlots({ ...benchSlot, target: target(4, 8, 10) }, rowSlot))))).toEqual(['unexplained']);
    });

    it('needs no reason for a cue text edit', () => {
      expect(check((d) => withDay(d, 'push', onlySlots({ ...benchSlot, cue: 'Pause longer.' }, rowSlot))).status).toBe('valid');
    });

    it('refuses every swap gone or a block set to one week with no reason, and needs none to change one swap', () => {
      const { swaps: _swaps, ...noSwaps } = rowSlot;
      const swapped = { ...rowSlot, swaps: [{ liftId: lift('incline-press'), label: 'Incline press' }] };
      const withSwap = program('2030-03-04', [{ key: 'push', blocks: [liftsBlock('main', [benchSlot, swapped], { title: 'Main' }), abBlock] }, ...DAYS.slice(1)], { standing });
      const from = (edit: (draft: ProgramDraft) => ProgramDraft) => checkPublish(draftOf(withSwap, '2030-03-11', edit), [withSwap], AT);
      expect(problemsOf(from((d) => withDay(d, 'push', onlySlots(benchSlot, noSwaps)))).map((p) => p.message)).toEqual([expect.stringContaining('"swaps:push/a2"')]);
      expect(from((d) => withDay(d, 'push', onlySlots(benchSlot, { ...swapped, swaps: [{ liftId: lift('incline-press'), label: 'Incline' }] }))).status).toBe('valid');
      expect(problemsOf(check((d) => withDay(d, 'push', [{ ...pushBlock, onlyWeek: day('2030-03-11') }, abBlock]))).map((p) => p.message)).toEqual([expect.stringContaining('"only-week:push/main"')]);
    });

    it('refuses an emptied block note with no reason, and needs none to edit one', () => {
      const noted = program('2030-03-04', [{ key: 'push', blocks: [{ ...pushBlock, note: 'Go slow.' }, abBlock] }, ...DAYS.slice(1)], { standing });
      const from = (note: string) => checkPublish(draftOf(noted, '2030-03-11', (d) => withDay(d, 'push', [{ ...pushBlock, note }, abBlock])), [noted], AT);
      expect(problemsOf(from(' ')).map((p) => p.message)).toEqual([expect.stringContaining('"block-note:push/main"')]);
      expect(from('Go slower.').status).toBe('valid');
    });
  });

  describe('a repeat publish', () => {
    const stored = program('2030-03-11', DAYS, { publishedAt: ms(T0 - 1000), standing });

    it('answers unchanged, ignoring the stamp', () => {
      expect(checkPublish(draftOf(stored, '2030-03-11'), [base, stored], AT)).toEqual({ status: 'unchanged', id: 'p:2030-03-11' });
    });

    it('answers unchanged even after its date has arrived', () => {
      expect(checkPublish(draftOf(stored, '2030-03-11'), [base, stored], { today: day('2030-03-20'), now: ms(T0) }).status).toBe('unchanged');
    });
  });

  describe('dates', () => {
    const upcoming = program('2030-03-11', DAYS, { standing });
    const changed = (d: ProgramDraft): ProgramDraft => ({ ...d, weeklyMinimum: 4 });

    it('freezes a version whose date has arrived, today included', () => {
      const onTheDay = checkPublish(draftOf(upcoming, '2030-03-11', changed), [base, upcoming], { today: day('2030-03-11'), now: ms(T0) });
      expect(onTheDay.status).toBe('frozen');
      expect(codes(onTheDay)).toEqual(['frozen']);
      const later = checkPublish(draftOf(upcoming, '2030-03-11', changed), [base, upcoming], { today: day('2030-03-12'), now: ms(T0) });
      expect(later).toMatchObject({ status: 'frozen', id: 'p:2030-03-11' });
    });

    it('names the earliest date allowed: today, or tomorrow once today has a version', () => {
      const older = checkPublish(draftOf(upcoming, '2030-03-11', changed), [base, upcoming], { today: day('2030-03-12'), now: ms(T0) });
      expect(older).toMatchObject({ status: 'frozen', earliestEffectiveFrom: '2030-03-12' });
      const today = checkPublish(draftOf(upcoming, '2030-03-11', changed), [base, upcoming], { today: day('2030-03-11'), now: ms(T0) });
      expect(today).toMatchObject({ status: 'frozen', earliestEffectiveFrom: '2030-03-12' });
    });

    it('lets an upcoming version be replaced, the day before its date', () => {
      const verdict = checkPublish(draftOf(upcoming, '2030-03-11', changed), [base, upcoming], { today: day('2030-03-10'), now: ms(T0) });
      expect(verdict.status).toBe('valid');
    });

    it('lets a new version start today', () => {
      expect(check((d) => d, '2030-03-08').status).toBe('valid');
    });

    it('refuses back-dating', () => {
      const verdict = check((d) => d, '2030-03-07');
      expect(verdict.status).toBe('invalid');
      expect(codes(verdict)).toEqual(['back-dated']);
    });

    it('compares with the version before the draft, not the one it replaces', () => {
      const replaced = program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }], { standing });
      const verdict = checkPublish(draftOf(base, '2030-03-11'), [base, replaced], AT);
      if (verdict.status !== 'valid') throw new Error(verdict.status);
      expect(verdict.diff).toEqual([]);
    });
  });

  describe('ids', () => {
    it('refuses a duplicate day, block, slot, lift or standing key, each named', () => {
      const dayTwice = check((d) => ({ ...d, days: [...d.days, { key: dayKey('push'), label: 'Again', blocks: [checklist('x')] }] }));
      expect(problemsOf(dayTwice).find((p) => p.code === 'duplicate-id')?.message).toContain('push');
      expect(codes(check((d) => withDay(d, 'push', [pushBlock, abBlock, { ...abBlock }])))).toEqual(['duplicate-id', 'duplicate-id']);
      expect(codes(check((d) => withDay(d, 'push', [pushBlock, liftsBlock('abs', [benchSlot], { title: 'Abs' })])))).toContain('duplicate-id');
      expect(codes(check((d) => ({ ...d, lifts: [...d.lifts, { id: lift('squat'), name: 'Again', aliases: [] }] })))).toEqual(['duplicate-id']);
      expect(codes(check((d) => ({ ...d, standing: [...d.standing, ...d.standing] })))).toEqual(['duplicate-id']);
    });

    it('allows the same slot id on another day', () => {
      expect(check((d) => withDay(d, 'legs', [liftsBlock('legs', [slot('b1', 'squat', 3), slot('a1', 'squat', 2)])])).status).toBe('valid');
    });
  });

  describe('the catalog', () => {
    it('refuses a slot or a swap naming a lift not in the catalog, with the path', () => {
      const typo = slot('a1', 'bench-prees', 3);
      const problems = problemsOf(check((d) => ({ ...withDay(d, 'push', onlySlots({ ...typo, target: benchSlot.target, swaps: [{ liftId: lift('nope'), label: 'Nope' }] }, rowSlot)), changes: [{ target: 'prescription:push/a1', why: 'x' }, { target: 'cue:push/a1', why: 'x' }, { target: 'cue:push/a1/incline-press', why: 'x' }] })));
      expect(problems.filter((p) => p.code === 'unknown-lift').map((p) => p.path)).toEqual(['days[0].blocks[0].slots[0].liftId', 'days[0].blocks[0].slots[0].swaps[0].liftId']);
    });

    it('accepts a slot naming an alias, which is in the catalog', () => {
      const verdict = check((d) => ({
        ...d,
        lifts: d.lifts.map((l) => (l.id === 'bench-press' ? { ...l, aliases: [lift('barbell-bench')] } : l)),
        days: withDay(d, 'push', onlySlots({ ...benchSlot, liftId: lift('barbell-bench') }, rowSlot)).days,
        changes: [{ target: 'prescription:push/a1', why: 'A new name.' }],
      }));
      expect(verdict.status).toBe('valid');
    });

    it('refuses a dropped lift, naming it', () => {
      const verdict = check((d) => ({ ...d, lifts: d.lifts.filter((l) => l.id !== 'crunch'), days: withDay(d, 'push', [pushBlock]).days, changes: [{ target: 'block:push/abs', why: 'Abs moved.' }] }));
      expect(codes(verdict)).toEqual(['catalog-drop']);
      expect(problemsOf(verdict)[0]?.message).toContain('crunch');
    });

    it('refuses a dropped alias', () => {
      const aliased = { ...base, lifts: base.lifts.map((l) => (l.id === 'squat' ? { ...l, aliases: [lift('back-squat')] } : l)) };
      expect(codes(checkPublish(draftOf(base, '2030-03-11'), [aliased], AT))).toEqual(['catalog-drop']);
    });

    it('allows a merge, which moves a lift into an alias, and its undo', () => {
      const merge = (d: ProgramDraft): ProgramDraft => ({ ...d, lifts: d.lifts.filter((l) => l.id !== 'crunch').map((l) => (l.id === 'squat' ? { ...l, aliases: [lift('crunch')] } : l)) });
      expect(check(merge).status).toBe('valid');
      const merged = { ...base, ...merge(draftOf(base, '2030-03-04')), id: base.id, publishedAt: base.publishedAt };
      expect(checkPublish(draftOf(base, '2030-03-11'), [merged], AT).status).toBe('valid');
    });

    it('refuses an alias that is also a lift, chains, claims itself, or is claimed twice', () => {
      const aliasOf = (id: string, alias: string) => (d: ProgramDraft): ProgramDraft => ({ ...d, lifts: d.lifts.map((l) => (l.id === id ? { ...l, aliases: [...l.aliases, lift(alias)] } : l)) });
      expect(codes(check(aliasOf('squat', 'crunch')))).toEqual(['alias-conflict']);
      expect(codes(check(aliasOf('squat', 'squat')))).toEqual(['alias-conflict']);
      const chain = (d: ProgramDraft) => aliasOf('crunch', 'old-crunch')(aliasOf('squat', 'crunch')(d));
      expect(codes(check(chain))).toEqual(['alias-conflict']);
      const twice = (d: ProgramDraft) => aliasOf('crunch', 'shared')(aliasOf('squat', 'shared')(d));
      expect(codes(check(twice))).toEqual(['alias-conflict']);
    });
  });

  describe('onlyWeek', () => {
    const blockIn = (week: string) => (d: ProgramDraft) => withDay(d, 'push', [pushBlock, abBlock, checklist('retest', { onlyWeek: day(week) })]);
    const noteIn = (week: string) => (d: ProgramDraft): ProgramDraft => ({ ...d, notes: [{ text: 'One week only.', onlyWeek: day(week) }] });

    it('refuses a week that is not a Monday, on a block or a note', () => {
      expect(problemsOf(check(blockIn('2030-03-12'))).map((p) => [p.code, p.path])).toEqual([['bad-only-week', 'days[0].blocks[2].onlyWeek']]);
      expect(problemsOf(check(noteIn('2030-03-12'))).map((p) => [p.code, p.path])).toEqual([['bad-only-week', 'notes[0].onlyWeek']]);
    });

    it('refuses a week before the version, on a block or a note', () => {
      expect(codes(check(blockIn('2030-03-04')))).toEqual(['bad-only-week']);
      expect(codes(check(noteIn('2030-03-04')))).toEqual(['bad-only-week']);
    });

    it('allows the version\'s own week, even mid-week, and later', () => {
      expect(check(blockIn('2030-03-11')).status).toBe('valid');
      expect(check(noteIn('2030-03-18')).status).toBe('valid');
      expect(check(noteIn('2030-03-04'), '2030-03-08').status).toBe('valid');
    });
  });

  describe('a note naming a day', () => {
    const noteOn = (key: string) => (d: ProgramDraft): ProgramDraft => ({ ...d, notes: [{ text: 'On that day.', day: dayKey(key) }] });

    it('publishes when the version holds that day', () => {
      expect(check(noteOn('push')).status).toBe('valid');
    });

    it('refuses a day the version lacks, because the note would show nowhere', () => {
      expect(problemsOf(check(noteOn('swim'))).map((p) => [p.code, p.path])).toEqual([['unknown-day', 'notes[0].day']]);
    });
  });

  it('reports every problem at once', () => {
    const verdict = check(
      (d) => ({
        ...withDay(d, 'push', onlySlots(benchSlot, { ...rowSlot, liftId: lift('typo-row') })),
        lifts: [...d.lifts.filter((l) => l.id !== 'squat'), { id: lift('crunch'), name: 'Again', aliases: [lift('cable-row')] }],
        notes: [{ text: 'x', onlyWeek: day('2030-03-05') }],
      }),
      '2030-03-07',
    );
    expect(new Set(codes(verdict))).toEqual(new Set(['back-dated', 'duplicate-id', 'unknown-lift', 'alias-conflict', 'catalog-drop', 'bad-only-week', 'unexplained']));
  });

  it('keeps every problem alongside frozen', () => {
    const upcoming = program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }]);
    const verdict = checkPublish(draftOf(upcoming, '2030-03-11', (d) => ({ ...d, notes: [{ text: 'x', onlyWeek: day('2030-03-12') }] })), [upcoming], { today: day('2030-03-11'), now: ms(T0) });
    expect(verdict.status).toBe('frozen');
    expect(codes(verdict)).toEqual(['frozen', 'bad-only-week']);
  });
});

describe('targetMondayOf', () => {
  it('is the next Monday, or today on a Monday', () => {
    expect(targetMondayOf(day('2030-03-10'))).toBe('2030-03-11');
    expect(targetMondayOf(day('2030-03-05'))).toBe('2030-03-11');
    expect(targetMondayOf(day('2030-03-11'))).toBe('2030-03-11');
  });
});

describe('snapshotOf', () => {
  const noDocs: TrainDocs = { programRev: 0, programs: [], sessions: [], performances: [], trainingNotes: [], weighIns: [], entries: [], workouts: [] };
  const AT_SUNDAY = { today: day('2030-03-10'), now: ms(T0 + 100 * 3_600_000), phoneLastSyncAt: ms(T0 - 5000) };
  const arrived = <T>(doc: T, rev = 1) => ({ doc, rev });

  function food(kcal: number, protein: number | undefined, date: string): Entry {
    const base = entry(newEntryId(), kcal, date);
    return { ...base, food: { ...base.food, nutrients: { kcal, ...(protein === undefined ? {} : { protein }) } } };
  }

  it('keeps the newest report when a mid-week version holds none', () => {
    const reported = program('2030-02-25', [{ key: 'push', blocks: [pushBlock] }], { report: { text: 'A question for you.' } });
    const snapshot = snapshotOf({ ...noDocs, programs: [arrived(reported), arrived(base)] }, AT_SUNDAY);
    expect(snapshot.program?.id).toBe(base.id);
    expect(snapshot.lastReport).toEqual({ from: '2030-02-25', report: { text: 'A question for you.' } });
  });

  it('gives the version in effect and the upcoming ones', () => {
    const next = program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }]);
    const later = program('2030-03-18', [{ key: 'push', blocks: [pushBlock] }]);
    const snapshot = snapshotOf({ ...noDocs, programs: [arrived(later), arrived(next), arrived(base)] }, AT_SUNDAY);
    expect(snapshot.program?.id).toBe(base.id);
    expect(snapshot.upcoming.map((p) => p.id)).toEqual([next.id, later.id]);
    expect(snapshot.targetMonday).toBe('2030-03-11');
    expect(snapshot.phoneLastSyncAt).toBe(T0 - 5000);
  });

  it('echoes the program rev it was read at, and the earliest date a change can start', () => {
    const snapshot = snapshotOf({ ...noDocs, programRev: 41, programs: [arrived(base, 40)] }, AT_SUNDAY);
    expect(snapshot.basedOnRev).toBe(41);
    expect(snapshot.earliestEffectiveFrom).toBe('2030-03-10');
    const startsToday = program('2030-03-10', [{ key: 'push', blocks: [pushBlock] }]);
    expect(snapshotOf({ ...noDocs, programs: [arrived(startsToday)] }, AT_SUNDAY).earliestEffectiveFrom).toBe('2030-03-11');
  });

  it('reads the number of weeks asked for', () => {
    const inside = session({ date: day('2030-02-25') });
    const outside = session({ date: day('2030-02-24') });
    const snapshot = snapshotOf({ ...noDocs, sessions: [arrived(inside), arrived(outside)] }, AT_SUNDAY, 2);
    expect(snapshot.weeks.map((week) => week.monday)).toEqual(['2030-02-25', '2030-03-04']);
    expect(snapshot.weeks.flatMap((week) => week.sessions).map((one) => one.id)).toEqual([inside.id]);
  });

  it('has an empty read before anything exists', () => {
    const snapshot = snapshotOf(noDocs, { ...AT_SUNDAY, phoneLastSyncAt: null });
    expect(snapshot.program).toBeNull();
    expect(snapshot.draft).toBeNull();
    expect(snapshot.phoneLastSyncAt).toBeNull();
    expect(snapshot.weeks).toHaveLength(6);
    expect(snapshot.weeks[0]?.monday).toBe('2030-01-28');
    expect(snapshot.weeks.at(-1)?.monday).toBe('2030-03-04');
  });

  describe('a week of training', () => {
    const push = session({ date: day('2030-03-06'), programId: pinned('2030-03-04'), startedAt: minutes(0), finishedAt: minutes(70), note: 'Felt strong.', skips: [{ slotId: slotId('c1'), note: 'Out of time' }] });
    const bench = performance({ session: push.id, date: '2030-03-06', slot: 'a1', lift: 'bench-press', label: 'Bench press', target: target(2, 8, 10), note: 'Grip slipped.', sets: [warm(lb(45, 10, 0)), lb(100, 10, 10), { ...lb(100, 10, 15), note: 'Clean' }] });
    const swap = performance({ session: push.id, date: '2030-03-06', slot: 'a2', lift: 'dumbbell-row', planned: 'cable-row', label: 'Dumbbell row', target: target(3, 8, 10), sets: [kg(25, 10, 20)] });
    const run = makeWorkout(metDraft('run_6', 20), { id: WorkoutId.parse('0b1e6c7a-3f2d-4e5a-8b9c-0d1e2f3a4b5c'), date: push.date, kg: 70, loggedAt: minutes(40) });

    const docs: TrainDocs = {
      ...noDocs,
      programs: [arrived(base)],
      sessions: [arrived(push)],
      performances: [arrived(bench), arrived(swap)],
      workouts: [run],
      trainingNotes: [{ id: TrainingNoteId.parse('1c2f7d8b-4a3e-4f6b-9cad-1e2f3a4b5c6d'), date: day('2030-03-09'), text: 'Sleep has been short.', at: ms(T0) }],
    };
    const snapshot = snapshotOf(docs, AT_SUNDAY);
    const week = snapshot.weeks.at(-1);
    const one = week?.sessions[0];

    it('counts the session and reads it with the phone\'s math', () => {
      expect(week?.sessionsDone).toBe(1);
      expect(one).toMatchObject({ id: push.id, date: push.date, day: 'Push', phase: 'finished' });
      expect(one?.exercises[0]).toEqual({
        liftId: lift('bench-press'),
        label: 'Bench press',
        sets: '100 lb x 10/10',
        warmups: 1,
        topLb: 100,
        volumeLb: 2000,
        e1rmLb: 100 * (1 + 10 / 30),
        addWeightNext: true,
        swappedFrom: null,
        added: false,
      });
    });

    it('takes cardio out of the minutes, from the first set to the finish', () => {
      expect(one?.minutes).toBe(70 - 20);
    });

    it('lists swaps and skips, tapped or not', () => {
      expect(one?.swaps).toEqual([{ date: push.date, plannedLiftId: lift('cable-row'), liftId: lift('dumbbell-row'), label: 'Dumbbell row' }]);
      expect(one?.exercises[1]?.swappedFrom).toBe('cable-row');
      expect(one?.skips).toEqual([{ slotId: slotId('c1'), label: 'crunch', note: 'Out of time' }]);
    });

    it('gathers every note, oldest first, including the training note', () => {
      expect(snapshot.notes.map((n) => [n.source, n.about, n.text])).toEqual([
        ['session', 'Push', 'Felt strong.'],
        ['skip', 'crunch', 'Out of time'],
        ['exercise', 'Bench press', 'Grip slipped.'],
        ['set', 'Bench press', 'Clean'],
        ['training', null, 'Sleep has been short.'],
      ]);
    });
  });

  it('marks an exercise added on the spot in a pinned session, and never one of an import', () => {
    const pinnedDay = session({ date: day('2030-03-06'), programId: pinned('2030-03-04'), finishedAt: minutes(30) });
    const imported = session({ date: day('2030-03-07'), source: 'notion', startedAt: undefined });
    const calves = performance({ session: pinnedDay.id, date: '2030-03-06', lift: 'calf-raise', sets: [bw(20, 1)] });
    const bench = performance({ session: pinnedDay.id, date: '2030-03-06', slot: 'a1', lift: 'bench-press', sets: [lb(100, 8, 2)] });
    const old = performance({ session: imported.id, date: '2030-03-07', lift: 'calf-raise', sets: [bw(20)] });
    const docs = { ...noDocs, programs: [arrived(base)], sessions: [arrived(pinnedDay), arrived(imported)], performances: [arrived(calves), arrived(bench), arrived(old)] };
    const sessions = snapshotOf(docs, AT_SUNDAY).weeks.at(-1)?.sessions;
    expect(sessions?.map((one) => one.exercises.map((exercise) => [exercise.liftId, exercise.added]))).toEqual([
      [
        ['calf-raise', true],
        ['bench-press', false],
      ],
      [['calf-raise', false]],
    ]);
  });

  it('marks a session open with no minutes, and does not call the rest of it skips', () => {
    const open = session({ date: day('2030-03-10'), programId: pinned('2030-03-04'), startedAt: ms(AT_SUNDAY.now - 60_000) });
    const bench = performance({ session: open.id, date: '2030-03-10', slot: 'a1', lift: 'bench-press', sets: [lb(100, 8, 0)] });
    const one = snapshotOf({ ...noDocs, programs: [arrived(base)], sessions: [arrived(open)], performances: [arrived(bench)] }, AT_SUNDAY).weeks.at(-1)?.sessions[0];
    expect(one?.phase).toBe('open');
    expect(one?.minutes).toBeNull();
    expect(one?.skips).toEqual([]);
  });

  it('counts a bodyweight lift as nulls, never 0', () => {
    const pull = session({ date: day('2030-03-06'), finishedAt: minutes(30) });
    const row = performance({ session: pull.id, date: '2030-03-06', lift: 'pull-up', sets: [bw(10)] });
    const exercise = snapshotOf({ ...noDocs, sessions: [arrived(pull)], performances: [arrived(row)] }, AT_SUNDAY).weeks.at(-1)?.sessions[0]?.exercises[0];
    expect(exercise).toMatchObject({ topLb: null, volumeLb: null, e1rmLb: null, sets: 'BW x 10', addWeightNext: false });
  });

  it('covers six weeks and no more', () => {
    const inside = session({ date: day('2030-01-28'), finishedAt: minutes(30) });
    const outside = session({ date: day('2030-01-27'), finishedAt: minutes(30) });
    const snapshot = snapshotOf({ ...noDocs, sessions: [arrived(inside), arrived(outside)] }, AT_SUNDAY);
    expect(snapshot.weeks.flatMap((w) => w.sessions.map((s) => s.id))).toEqual([inside.id]);
  });

  it('averages weigh-ins by week', () => {
    const snapshot = snapshotOf({ ...noDocs, weighIns: [weighIn('2030-03-05', 80), weighIn('2030-03-04', 82), weighIn('2030-02-26', 83)] }, AT_SUNDAY);
    expect(snapshot.weeks.at(-1)?.weighIns).toEqual({
      readings: [
        { date: day('2030-03-04'), kg: 82 },
        { date: day('2030-03-05'), kg: 80 },
      ],
      averageKg: 81,
    });
    expect(snapshot.weeks.at(-2)?.weighIns.averageKg).toBe(83);
    expect(snapshot.weeks[0]?.weighIns).toEqual({ readings: [], averageKg: null });
  });

  it('averages calories and protein over days logged, through the diary\'s math', () => {
    const entries = [food(1500, 100, '2030-03-04'), food(500, 50, '2030-03-04'), food(1000, 100, '2030-03-06')];
    expect(snapshotOf({ ...noDocs, entries }, AT_SUNDAY).weeks.at(-1)?.diet).toEqual({ daysLogged: 2, averageKcal: 1500, averageProtein: 125, proteinIsLowerBound: false });
  });

  it('says when a food with no protein makes the average a lower bound', () => {
    const entries = [food(1000, 100, '2030-03-04'), food(500, undefined, '2030-03-04')];
    expect(snapshotOf({ ...noDocs, entries }, AT_SUNDAY).weeks.at(-1)?.diet).toEqual({ daysLogged: 1, averageKcal: 1500, averageProtein: 100, proteinIsLowerBound: true });
  });

  it('has no average for a week with nothing logged', () => {
    expect(snapshotOf(noDocs, AT_SUNDAY).weeks[0]?.diet).toEqual({ daysLogged: 0, averageKcal: null, averageProtein: null, proteinIsLowerBound: false });
  });

  it('lists a typed name the catalog has not placed, leaving out catalog ids and aliases', () => {
    const aliased = { ...base, lifts: base.lifts.map((l) => (l.id === 'squat' ? { ...l, aliases: [lift('back-squat')] } : l)) };
    const rows = [
      performance({ lift: 'squat', sets: [lb(100, 5)] }),
      performance({ lift: 'back-squat', sets: [lb(100, 5)] }),
      performance({ lift: 'landmine-press', label: 'Landmine', date: '2030-03-01', sets: [lb(40, 8)] }),
      performance({ lift: 'landmine-press', label: 'Landmine press', date: '2030-03-05', sets: [lb(40, 8)] }),
    ].map((row) => arrived(row));
    expect(snapshotOf({ ...noDocs, programs: [arrived(aliased)], performances: rows }, AT_SUNDAY).uncataloged).toEqual([{ liftId: lift('landmine-press'), label: 'Landmine press', lastDone: day('2030-03-05') }]);
  });

  describe('newSinceLastReport', () => {
    const reported = { ...base, report: { text: 'Good week.' } };
    const flag = (rev: number, perfRev?: number, sessionDate = '2030-03-06') => {
      const s = session({ date: day(sessionDate), finishedAt: minutes(30) });
      const row = performance({ session: s.id, date: sessionDate, lift: 'squat', sets: [lb(100, 5)] });
      const docs: TrainDocs = { ...noDocs, programs: [arrived(reported, 50)], sessions: [arrived(s, rev)], performances: perfRev === undefined ? [] : [arrived(row, perfRev)] };
      return snapshotOf(docs, AT_SUNDAY).weeks.flatMap((w) => w.sessions).find((one) => one.id === s.id)?.newSinceLastReport;
    };

    it('flags a session that arrived after the last report, by arrival and not by date', () => {
      expect(flag(49)).toBe(false);
      expect(flag(51)).toBe(true);
    });

    it('flags an old session whose sets arrived late', () => {
      expect(flag(10, 60)).toBe(true);
      expect(flag(10, 20)).toBe(false);
    });

    it('reaches the review even when it is older than six weeks', () => {
      expect(flag(51, undefined, '2030-01-07')).toBe(true);
      expect(flag(49, undefined, '2030-01-07')).toBeUndefined();
    });

    it('flags everything before the first report, without reading all of history', () => {
      const old = session({ date: day('2030-01-07'), finishedAt: minutes(30) });
      const recent = session({ date: day('2030-03-06'), finishedAt: minutes(30) });
      const snapshot = snapshotOf({ ...noDocs, programs: [arrived(base, 50)], sessions: [arrived(old, 1), arrived(recent, 2)] }, AT_SUNDAY);
      expect(snapshot.weeks).toHaveLength(6);
      expect(snapshot.weeks.flatMap((w) => w.sessions).map((s) => [s.id, s.newSinceLastReport])).toEqual([[recent.id, true]]);
    });

    it('takes the report from whichever version filed it last, including an upcoming one', () => {
      const next = { ...program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }]), report: { text: 'Next.' } };
      const s = session({ date: day('2030-03-06'), finishedAt: minutes(30) });
      const docs: TrainDocs = { ...noDocs, programs: [arrived(reported, 50), arrived(next, 70)], sessions: [arrived(s, 60)] };
      expect(snapshotOf(docs, AT_SUNDAY).weeks.at(-1)?.sessions[0]?.newSinceLastReport).toBe(false);
    });
  });

  describe('the draft', () => {
    const retest = liftsBlock('retest', [slot('r1', 'squat', 1)], { onlyWeek: day('2030-03-04') });
    const laterRetest = checklist('later', { onlyWeek: day('2030-03-18') });
    const inEffect = program(
      '2030-03-04',
      [
        { key: 'push', blocks: [pushBlock, abBlock, retest, laterRetest] },
        { key: 'once', blocks: [checklist('intro', { onlyWeek: day('2030-03-04') })] },
      ],
      {
        standing,
        report: { text: 'Good week.' },
        notes: [{ text: 'Deload.', onlyWeek: day('2030-03-04') }, { text: 'Standing callout.' }],
        changes: [{ target: 'slot:push/a2', why: 'Old reason.' }],
      },
    );
    const draft = snapshotOf({ ...noDocs, programs: [arrived(inEffect)] }, AT_SUNDAY).draft;

    it('is the version in effect re-dated to the target Monday', () => {
      expect(draft?.effectiveFrom).toBe('2030-03-11');
      expect(draft?.weeklyMinimum).toBe(inEffect.weeklyMinimum);
      expect(draft?.lifts).toEqual(inEffect.lifts);
      expect(draft?.standing).toEqual(standing);
    });

    it('has lost its one-week items, report, old explanations and stamps', () => {
      expect(draft?.days.map((d) => [d.key, d.blocks.map((b) => b.id)])).toEqual([['push', [blockId('main'), blockId('abs'), blockId('later')]]]);
      expect(draft?.notes).toEqual([{ text: 'Standing callout.' }]);
      expect(draft?.report).toBeUndefined();
      expect(draft?.changes).toEqual([]);
      expect(draft).not.toHaveProperty('id');
      expect(draft).not.toHaveProperty('publishedAt');
    });

    it('starts from a version already published for the target Monday, so a following version is not lost', () => {
      const lightWeek = { ...inEffect, weeklyMinimum: 2 };
      const following = { ...program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }], { standing }), weeklyMinimum: 4 };
      const onTop = snapshotOf({ ...noDocs, programs: [arrived(lightWeek), arrived(following)] }, AT_SUNDAY);
      expect(onTop.program?.id).toBe(lightWeek.id);
      expect(onTop.draft?.weeklyMinimum).toBe(4);
      expect(onTop.draft?.effectiveFrom).toBe('2030-03-11');
    });

    it('exists when only an upcoming version does', () => {
      const first = program('2030-03-11', [{ key: 'push', blocks: [pushBlock] }]);
      const onlyNext = snapshotOf({ ...noDocs, programs: [arrived(first)] }, AT_SUNDAY);
      expect(onlyNext.program).toBeNull();
      expect(onlyNext.draft?.effectiveFrom).toBe('2030-03-11');
    });

    it('publishes as it stands, with nothing to explain', () => {
      const verdict = checkPublish(draft, [inEffect], { today: AT_SUNDAY.today, now: ms(T0) });
      if (verdict.status !== 'valid') throw new Error(JSON.stringify(verdict));
      expect(verdict.diff.filter((item) => item.needsReason)).toEqual([]);
      expect(verdict.program.id).toBe('p:2030-03-11');
    });

    it('answers a repeat publish of a saved draft as unchanged', () => {
      const first = checkPublish(draft, [inEffect], { today: AT_SUNDAY.today, now: ms(T0) });
      if (first.status !== 'valid') throw new Error(first.status);
      expect(checkPublish(draft, [inEffect, first.program], { today: AT_SUNDAY.today, now: ms(T0 + 1000) })).toEqual({ status: 'unchanged', id: 'p:2030-03-11' });
    });
  });
});
