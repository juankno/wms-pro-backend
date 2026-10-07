import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './job-worker';

describe('retryDelayMs', () => {
  it('doubles the wait after each failed attempt', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
  });
});
