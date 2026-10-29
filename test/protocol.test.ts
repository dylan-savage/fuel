import { describe, expect, it } from 'vitest';
import { Gtin } from '../src/domain/food.js';
import { formatRef, parseRef } from '../src/protocol.js';

describe('lookup refs', () => {
  it('round-trip a barcode and a USDA id through the path segment', () => {
    const gtin = { kind: 'gtin', gtin: Gtin.parse('0049000000443') } as const;
    expect(formatRef(gtin)).toBe('gtin:0049000000443');
    expect(parseRef('gtin:0049000000443')).toEqual(gtin);
    expect(parseRef('usda:2346404')).toEqual({ kind: 'usda', fdcId: 2346404 });
  });

  it('refuse anything that is not a verified 13-digit GTIN or a USDA id', () => {
    for (const bad of ['gtin:049000000443', 'gtin:0049000000444', 'usda:abc', 'usda:0', 'off:123', 'gtin']) {
      expect(parseRef(bad)).toBeNull();
    }
  });
});
