import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateMovementDto, TransferDto, UpdateStockSettingsDto } from './create-movement.dto';

const errorsFor = async <T extends object>(cls: new () => T, payload: object) =>
  (await validate(plainToInstance(cls, payload))).map((e) => e.property);

describe('stock DTOs', () => {
  it('accepts a valid manual movement', async () => {
    expect(await errorsFor(CreateMovementDto, { type: 'adjustment_increase', quantity: 3 })).toEqual([]);
  });

  it.each([0, -5, 1.5])('rejects quantity %p', async (quantity) => {
    expect(await errorsFor(CreateMovementDto, { type: 'adjustment_increase', quantity })).toContain('quantity');
  });

  it.each(['order_shipment', 'customer_return', 'transfer_out'])('rejects system-only type %s', async (type) => {
    expect(await errorsFor(CreateMovementDto, { type, quantity: 1 })).toContain('type');
  });

  it('rejects a non-positive transfer quantity', async () => {
    const payload = { productId: 'p', fromWarehouseId: 'a', toWarehouseId: 'b', quantity: -1 };
    expect(await errorsFor(TransferDto, payload)).toContain('quantity');
  });

  it('accepts clearing the location and rejects a negative minimum stock', async () => {
    expect(await errorsFor(UpdateStockSettingsDto, { location: null })).toEqual([]);
    expect(await errorsFor(UpdateStockSettingsDto, { minStock: -1 })).toContain('minStock');
  });
});
