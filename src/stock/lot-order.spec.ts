import { PickingStrategy } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { lotOrder, tenantPickingStrategy } from './lot-stock';

const lot = (code: string, received: string, expires: string | null) => ({
  code,
  createdAt: new Date(received),
  expiresAt: expires ? new Date(expires) : null,
});

const lots = [
  lot('OLD-LATE', '2026-01-01', '2028-01-01'),
  lot('NEW-SOON', '2026-06-01', '2026-12-01'),
  lot('MID-NONE', '2026-03-01', null),
];

const ordered = (strategy: PickingStrategy) => [...lots].sort(lotOrder(strategy)).map((l) => l.code);

describe('lotOrder', () => {
  it('ships the first to expire first, lots without expiry last (FEFO)', () => {
    expect(ordered(PickingStrategy.fefo)).toEqual(['NEW-SOON', 'OLD-LATE', 'MID-NONE']);
  });

  it('ships by reception date for FIFO and LIFO', () => {
    expect(ordered(PickingStrategy.fifo)).toEqual(['OLD-LATE', 'MID-NONE', 'NEW-SOON']);
    expect(ordered(PickingStrategy.lifo)).toEqual(['NEW-SOON', 'MID-NONE', 'OLD-LATE']);
  });

  it('reads the tenant default and falls back to FEFO', () => {
    expect(tenantPickingStrategy({ pickingStrategy: 'lifo' })).toBe(PickingStrategy.lifo);
    expect(tenantPickingStrategy({ pickingStrategy: 'random' })).toBe(PickingStrategy.fefo);
    expect(tenantPickingStrategy(null)).toBe(PickingStrategy.fefo);
  });
});
