import { LocationType } from '@prisma/client';

export const MAX_GENERATED_LOCATIONS = 5000;
export const CODE_SEPARATOR = '-';

export interface LevelSpec {
  type: LocationType;
  // First value of the sequence: digits ("01", "1") or a single letter ("A").
  start: string;
  count: number;
}

export interface GeneratedLocation {
  code: string;
  parentCode: string | null;
  type: LocationType;
  depth: number;
}

const ALPHABET_END = 'Z'.charCodeAt(0);

export function sequenceValues(start: string, count: number): string[] {
  if (/^\d+$/.test(start)) {
    const first = Number(start);
    return Array.from({ length: count }, (_, i) => String(first + i).padStart(start.length, '0'));
  }
  if (/^[A-Za-z]$/.test(start)) {
    const first = start.toUpperCase().charCodeAt(0);
    if (first + count - 1 > ALPHABET_END) throw new RangeError(`Sequence starting at ${start} goes past Z`);
    return Array.from({ length: count }, (_, i) => String.fromCharCode(first + i));
  }
  throw new RangeError(`Invalid sequence start "${start}": use digits or a single letter`);
}

export function countGeneratedLocations(levels: LevelSpec[]): number {
  let total = 0;
  let nodesAtDepth = 1;
  for (const level of levels) {
    nodesAtDepth *= level.count;
    total += nodesAtDepth;
  }
  return total;
}

// Expands nested levels into every node, parents first: [A, B] × [01, 02] → A, B, A-01, A-02, B-01, B-02.
export function expandLevels(levels: LevelSpec[], rootCode: string | null = null): GeneratedLocation[] {
  const total = countGeneratedLocations(levels);
  if (total > MAX_GENERATED_LOCATIONS) {
    throw new RangeError(`Would create ${total} locations; the maximum is ${MAX_GENERATED_LOCATIONS}`);
  }

  const nodes: GeneratedLocation[] = [];
  let parents: (string | null)[] = [rootCode];
  levels.forEach((level, depth) => {
    const values = sequenceValues(level.start, level.count);
    const current: string[] = [];
    for (const parentCode of parents) {
      for (const value of values) {
        const code = parentCode ? `${parentCode}${CODE_SEPARATOR}${value}` : value;
        nodes.push({ code, parentCode, type: level.type, depth });
        current.push(code);
      }
    }
    parents = current;
  });
  return nodes;
}
