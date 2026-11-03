import { describe, expect, it } from 'vitest';
import { checkPublish, parseProgramDraft, programDiff, sameContent, snapshotOf, targetMondayOf, type DiffItem, type PublishVerdict, type TrainDocs } from '../src/domain/coach.js';
import { makeWorkout, metDraft } from '../src/domain/burn.js';
import type { Entry } from '../src/domain/diary.js';
import { TrainingNoteId, WorkoutId } from '../src/domain/ids.js';
import { ProgramDraft, type Block, type Program, type Slot } from '../src/domain/program.js';
import { entry, newEntryId, weighIn } from './fixtures.js';
import { T0, blockId, bw, checklist, day, dayKey, kg, lb, lift, liftsBlock, minutes, ms, performance, pinned, program, session, slot, slotId, target, warm } from './training.fixtures.js';

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
    expect(programDiff(base, moved)).toEqual([]);
  });

  it('lists a removed or emptied cue, on a slot and on a swap', () => {
    const { cue: _cue, ...noCue } = benchSlot;
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noCue, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1']]);
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots({ ...benchSlot, cue: '  ' }, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1']]);
    const noSwapCue = { ...benchSlot, swaps: [{ liftId: lift('incline-press'), label: 'Incline press' }] };
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noSwapCue, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1/incline-press']]);
    const { swaps: _swaps, ...noSwaps } = benchSlot;
    expect(kinds(diffOf((d) => withDay(d, 'push', onlySlots(noSwaps, rowSlot))))).toEqual([['cue-removed', 'cue:push/a1/incline-press']]);
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
