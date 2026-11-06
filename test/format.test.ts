import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checklistLabel, clipped, editable, lbField, macrosLine, parseNumber, pastMoment, planSections, prescriptionText, servingLabel, setOfText, supersetLabel, targetNotes, weekdayName } from '../src/client/screens/format.js';
import { KG_PER_LB } from '../src/domain/goals.js';
import { dayParts, type PlannedDay } from '../src/domain/program.js';
import { checklist, day, dayKey, liftsBlock, slot, target } from './training.fixtures.js';

describe('form field prefills', () => {
  it('parse back to the exact value, so saving an untouched field changes nothing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (thousandths) => {
        const n = thousandths / 1000;
        expect(parseNumber(editable(n))).toBe(n);
      }),
    );
    expect(editable(22.5)).toBe('22.5');
    expect(editable(1440)).toBe('1440');
    expect(editable(0.125 * 100)).toBe('12.5');
  });

  it('show a body weight in lb to a tenth with no grouping', () => {
    expect(lbField(182.2 * KG_PER_LB)).toBe('182.2');
    expect(lbField(1399.9 * KG_PER_LB)).toBe('1399.9');
  });
});

describe('a food\'s wording', () => {
  it('gives a serving its size once, even when the label is more exact than the rounded size', () => {
    expect(servingLabel('g', { label: '1 slice', amount: 30 })).toBe('1 slice (30 g)');
    expect(servingLabel('g', { label: '1 portion (28.3 g)', amount: 28.3 })).toBe('1 portion (28.3 g)');
    expect(servingLabel('ml', { label: '330ml can', amount: 330 })).toBe('330ml can');
    expect(servingLabel('portion', { label: '1 bar', amount: 1 })).toBe('1 bar');
  });

  it('leaves a dash for a macro the food does not say, and zero as zero', () => {
    expect(macrosLine({ protein: 18.25, carbs: 0 })).toBe('Protein 18 · Carbs 0 · Fat –');
    expect(macrosLine(null)).toBe('Protein – · Carbs – · Fat –');
  });
});

describe('the Train tab\'s wording', () => {
  it('names a weekday from the diary date alone', () => {
    expect(weekdayName(day('2030-03-06'))).toBe('Wed');
  });

  it('says when something was published by weekday within the last week, and by date before it', () => {
    const published = new Date('2030-03-10T07:02:00').getTime();
    expect(pastMoment(published, day('2030-03-11'))).toMatch(/^Sunday 7:02\sAM$/);
    expect(pastMoment(published, day('2030-03-16'))).toMatch(/^Sunday 7:02\sAM$/);
    expect(pastMoment(published, day('2030-03-17'))).toMatch(/^Mar 10, 7:02\sAM$/);
  });

  it.each([
    [target(3, 8, 12), '3 × 8–12', []],
    [target(2, 10, 10), '2 × 10', []],
    [target(3, 8, 12, { perSide: 'left-first' }), '3 × 8–12', ['Per side, left first']],
    [target(3, 8, 12, { perSide: 'right-first' }), '3 × 8–12', ['Per side, right first']],
    [target(3, 8, 12, { perSide: 'either' }), '3 × 8–12', ['Per side']],
    [target(2, 15, 15, { load: 'bodyweight' }), '2 × 15', ['Bodyweight']],
    [target(2, 15, 15, { load: 'band', perSide: 'either' }), '2 × 15', ['Per side', 'Band']],
    [target(3, 8, 12, { load: 'weight' }), '3 × 8–12', []],
  ])('writes a prescription as %j', (prescribed, text, notes) => {
    expect(prescriptionText(prescribed)).toBe(text);
    expect(targetNotes(prescribed)).toEqual(notes);
  });

  describe('a day read as lists', () => {
    const pair = liftsBlock('pair', [slot('a1', 'seal-row', 3), slot('a2', 'pin-press', 3)], { restSeconds: 60 });
    const one = liftsBlock('one', [slot('b1', 'front-squat', 3)], { restSeconds: 90 });
    const warm = checklist('warm', { title: 'Warm-up', items: ['One', 'Two', 'Three'] });
    const plan = (...blocks: PlannedDay['blocks']): PlannedDay => ({ key: dayKey('a'), label: 'A', minutes: undefined, blocks });

    it('labels only a superset, the way the design words it', () => {
      const [first, second] = dayParts(plan(pair, liftsBlock('named', [slot('c1', 'dip', 2), slot('c2', 'row', 2)], { title: 'Finisher' })));
      expect(first && supersetLabel(first)).toBe('Superset · 3 rounds · rest 60s');
      expect(second && supersetLabel(second)).toBe('Finisher · 2 rounds');
      const [alone] = dayParts(plan(one));
      expect(alone && supersetLabel(alone)).toBeNull();
    });

    it('counts a checklist in moves', () => {
      expect(checklistLabel(warm)).toBe('Warm-up · 3 moves');
      expect(checklistLabel(checklist('short', { items: ['One'] }))).toBe('Checklist · 1 move');
    });

    it('keeps a superset to itself, and the rows around it in one list each', () => {
      const sections = planSections(dayParts(plan(warm, one, pair, one, warm)));
      expect(sections.map((section) => [section.label, section.parts.length])).toEqual([
        [null, 2],
        ['Superset · 3 rounds · rest 60s', 1],
        [null, 2],
      ]);
    });
  });

  it('counts a set within its exercise, and calls one past the prescription extra', () => {
    const threeSets = { sets: 3, reps: { min: 8, max: 12 } };
    expect(setOfText(threeSets, 1)).toBe('Set 1 of 3');
    expect(setOfText(threeSets, 3)).toBe('Set 3 of 3');
    expect(setOfText(threeSets, 4)).toBe('Extra set');
  });

  it('counts a set with no prescription and no end, as on an exercise he added', () => {
    expect(setOfText(undefined, 1)).toBe('Set 1');
    expect(setOfText(undefined, 12)).toBe('Set 12');
  });

  it('clips long text at a word and leaves short text whole', () => {
    expect(clipped('short enough', 12)).toBeNull();
    expect(clipped('one two three four', 9)).toBe('one two…');
    expect(clipped('unbrokenwordthatrunslong', 8)).toBe('unbroken…');
  });
});
