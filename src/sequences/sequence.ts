import { Prisma } from '@prisma/client';
import { requireTenantId } from '../tenancy/tenant-context';

export const SEQUENCE_DEFAULTS = {
  picking: 'PK',
  purchase: 'OC',
  sales: 'PV',
} as const;

export type SequenceKey = keyof typeof SEQUENCE_DEFAULTS;

export const formatReference = (prefix: string, value: number, padding: number) =>
  `${prefix}-${String(value).padStart(padding, '0')}`;

const MAX_ATTEMPTS = 20;

// Takes the next value atomically (concurrent orders never share one) and skips values already
// used by references typed by hand, checked with `isTaken`.
export async function nextReference(
  tx: Prisma.TransactionClient,
  key: SequenceKey,
  isTaken: (reference: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [row] = await tx.$queryRaw<{ prefix: string; padding: number; value: number }[]>`
      INSERT INTO sequences (id, "tenantId", key, prefix, "nextValue", "updatedAt")
      VALUES (gen_random_uuid()::text, ${requireTenantId()}, ${key}, ${SEQUENCE_DEFAULTS[key]}, 2, now())
      ON CONFLICT ("tenantId", key) DO UPDATE SET "nextValue" = sequences."nextValue" + 1, "updatedAt" = now()
      RETURNING prefix, padding, "nextValue" - 1 AS value`;
    const reference = formatReference(row.prefix, Number(row.value), row.padding);
    if (!(await isTaken(reference))) return reference;
  }
  throw new Error(`Could not generate a free reference for sequence ${key}`);
}
