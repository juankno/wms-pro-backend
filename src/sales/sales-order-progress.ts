import { Prisma, SalesOrderStatus } from '@prisma/client';

interface ItemProgress {
  quantity: number;
  releasedQuantity: number;
  shippedQuantity: number;
}

export function salesOrderStatus(items: ItemProgress[]): SalesOrderStatus {
  if (items.every((item) => item.shippedQuantity >= item.quantity)) return SalesOrderStatus.shipped;
  if (items.some((item) => item.shippedQuantity > 0)) return SalesOrderStatus.partially_shipped;
  if (items.every((item) => item.releasedQuantity >= item.quantity)) return SalesOrderStatus.released;
  if (items.some((item) => item.releasedQuantity > 0)) return SalesOrderStatus.partially_released;
  return SalesOrderStatus.open;
}

export interface ProgressChange {
  released: number;
  shipped: number;
}

// Applies released/shipped deltas from picking and packing, then refreshes the order status.
export async function applySalesOrderProgress(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  changes: Map<string, ProgressChange>,
): Promise<void> {
  for (const [productId, change] of changes) {
    if (change.released === 0 && change.shipped === 0) continue;
    await tx.salesOrderItem.updateMany({
      where: { salesOrderId, productId },
      data: { releasedQuantity: { increment: change.released }, shippedQuantity: { increment: change.shipped } },
    });
  }
  const order = await tx.salesOrder.findUnique({ where: { id: salesOrderId }, include: { items: true } });
  if (!order || order.status === SalesOrderStatus.cancelled) return;
  await tx.salesOrder.update({ where: { id: salesOrderId }, data: { status: salesOrderStatus(order.items) } });
}
