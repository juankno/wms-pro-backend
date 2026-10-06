import { SalesOrderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { salesOrderStatus } from './sales-order-progress';

const item = (quantity: number, releasedQuantity: number, shippedQuantity: number) => ({ quantity, releasedQuantity, shippedQuantity });

describe('salesOrderStatus', () => {
  it.each([
    [[item(5, 0, 0)], SalesOrderStatus.open],
    [[item(5, 3, 0)], SalesOrderStatus.partially_released],
    [[item(5, 5, 0), item(2, 2, 0)], SalesOrderStatus.released],
    [[item(5, 5, 1)], SalesOrderStatus.partially_shipped],
    [[item(5, 5, 5), item(2, 2, 2)], SalesOrderStatus.shipped],
  ])('%j → %s', (items, status) => {
    expect(salesOrderStatus(items)).toBe(status);
  });
});
