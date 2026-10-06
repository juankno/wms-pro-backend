import { MovementType, Prisma } from '@prisma/client';

export const STOCK_STATUSES = ['ok', 'low', 'out'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const INBOUND_MOVEMENT_TYPES: MovementType[] = [
  MovementType.opening_balance,
  MovementType.purchase_receipt,
  MovementType.customer_return,
  MovementType.transfer_in,
  MovementType.adjustment_increase,
];

export const OUTBOUND_MOVEMENT_TYPES: MovementType[] = [
  MovementType.order_shipment,
  MovementType.transfer_out,
  MovementType.adjustment_decrease,
];

const AVAILABLE = Prisma.sql`("onHand" - "reserved")`;

// Single definition of stock status, based on available units (physical minus reserved).
export const STOCK_STATUS_CONDITION: Record<StockStatus, Prisma.Sql> = {
  out: Prisma.sql`${AVAILABLE} <= 0`,
  low: Prisma.sql`${AVAILABLE} > 0 AND ${AVAILABLE} <= "minStock"`,
  ok: Prisma.sql`${AVAILABLE} > "minStock"`,
};

// Raw SQL bypasses the tenant extension, so stock queries filter by tenant explicitly.
export function stockScopeCondition(tenantId: string, warehouseId?: string): Prisma.Sql {
  return warehouseId
    ? Prisma.sql`ws."tenantId" = ${tenantId} AND ws."warehouseId" = ${warehouseId}`
    : Prisma.sql`ws."tenantId" = ${tenantId}`;
}
