import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clipped, editable, lbField, parseNumber, pastMoment, prescriptionText, weekdayName } from '../src/client/screens/format.js';
import { KG_PER_LB } from '../src/domain/goals.js';
import { day, target } from './training.fixtures.js';

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
    [target(3, 8, 12), '3 × 8–12'],
    [target(2, 10, 10), '2 × 10'],
    [target(3, 8, 12, { perSide: 'left-first' }), '3 × 8–12, per side, left first'],
    [target(3, 8, 12, { perSide: 'right-first' }), '3 × 8–12, per side, right first'],
    [target(3, 8, 12, { perSide: 'either' }), '3 × 8–12, per side'],
    [target(2, 15, 15, { load: 'bodyweight' }), '2 × 15, bodyweight'],
    [target(2, 15, 15, { load: 'band' }), '2 × 15, band'],
    [target(3, 8, 12, { load: 'weight' }), '3 × 8–12'],
  ])('writes a prescription as %j', (prescribed, text) => {
    expect(prescriptionText(prescribed)).toBe(text);
  });

  it('clips long text at a word and leaves short text whole', () => {
    expect(clipped('short enough', 12)).toBeNull();
    expect(clipped('one two three four', 9)).toBe('one two…');
    expect(clipped('unbrokenwordthatrunslong', 8)).toBe('unbroken…');
  });
});
