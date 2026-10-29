import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { editable, lbField, parseNumber } from '../src/client/screens/format.js';
import { KG_PER_LB } from '../src/domain/goals.js';

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
