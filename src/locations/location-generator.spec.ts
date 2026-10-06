import { LocationType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { countGeneratedLocations, expandLevels, sequenceValues } from './location-generator';

describe('sequenceValues', () => {
  it('keeps the zero padding of numeric starts', () => {
    expect(sequenceValues('08', 3)).toEqual(['08', '09', '10']);
    expect(sequenceValues('1', 2)).toEqual(['1', '2']);
  });

  it('increments letters and refuses to go past Z', () => {
    expect(sequenceValues('x', 3)).toEqual(['X', 'Y', 'Z']);
    expect(() => sequenceValues('Y', 3)).toThrow(RangeError);
  });

  it('rejects other starts', () => {
    expect(() => sequenceValues('AB', 2)).toThrow(RangeError);
  });
});

describe('expandLevels', () => {
  const levels = [
    { type: LocationType.aisle, start: 'A', count: 2 },
    { type: LocationType.rack, start: '01', count: 2 },
  ];

  it('creates parents before children with path codes', () => {
    expect(expandLevels(levels).map((n) => [n.code, n.parentCode])).toEqual([
      ['A', null],
      ['B', null],
      ['A-01', 'A'],
      ['A-02', 'A'],
      ['B-01', 'B'],
      ['B-02', 'B'],
    ]);
  });

  it('prefixes codes with the root location', () => {
    expect(expandLevels([levels[1]], 'Z1').map((n) => n.code)).toEqual(['Z1-01', 'Z1-02']);
  });

  it('caps the number of generated locations', () => {
    const huge = [
      { type: LocationType.aisle, start: '1', count: 100 },
      { type: LocationType.rack, start: '1', count: 100 },
    ];
    expect(countGeneratedLocations(huge)).toBe(10_100);
    expect(() => expandLevels(huge)).toThrow(RangeError);
  });
});
