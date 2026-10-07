import { describe, expect, it } from 'vitest';
import { inChunks } from './imports.service';

describe('inChunks', () => {
  it('queries big lists in chunks below the PostgreSQL parameter limit', async () => {
    const values = Array.from({ length: 25_001 }, (_, index) => `C${index}`);
    const sizes: number[] = [];

    const found = await inChunks(values, (chunk) => {
      sizes.push(chunk.length);
      return Promise.resolve(chunk.filter((value) => value.endsWith('000')));
    });

    expect(sizes).toEqual([10_000, 10_000, 5_001]);
    expect(found).toHaveLength(25);
  });

  it('does not query an empty list', async () => {
    let calls = 0;
    await inChunks([], () => Promise.resolve([++calls]));
    expect(calls).toBe(0);
  });
});
