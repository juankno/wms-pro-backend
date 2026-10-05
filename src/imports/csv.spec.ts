import { describe, expect, it } from 'vitest';
import { detectDelimiter, missingColumns, parseBoolean, parseCsv, parseDate, parsePositiveInt } from './csv';

describe('csv helpers', () => {
  it('parses comma and semicolon files with quotes and a BOM', () => {
    expect(parseCsv('﻿code,name\nA1,"Tornillo, 3/8"\n')).toEqual([{ code: 'A1', name: 'Tornillo, 3/8' }]);
    expect(parseCsv('code;name\nA1;Tuerca\n\n')).toEqual([{ code: 'A1', name: 'Tuerca' }]);
  });

  it('detects the delimiter from the header', () => {
    expect(detectDelimiter('a;b;c\n1,2;3')).toBe(';');
    expect(detectDelimiter('a,b\n')).toBe(',');
  });

  it('parses booleans and positive integers leniently', () => {
    expect(['Sí', 'x', 'TRUE'].map(parseBoolean)).toEqual([true, true, true]);
    expect(['no', '0'].map(parseBoolean)).toEqual([false, false]);
    expect(parseBoolean('quizás')).toBeUndefined();
    expect(['5', '0', '-1', '1.5', ''].map(parsePositiveInt)).toEqual([5, undefined, undefined, undefined, undefined]);
  });

  it('parses only valid ISO dates', () => {
    expect(parseDate('2027-06-30')?.toISOString()).toBe('2027-06-30T00:00:00.000Z');
    expect(['30/06/2027', '2027-02-30', '2027-6-1'].map(parseDate)).toEqual([undefined, undefined, undefined]);
  });

  it('reports missing required columns', () => {
    expect(missingColumns([{ code: 'x' }], ['code', 'name'])).toEqual(['name']);
  });
});
