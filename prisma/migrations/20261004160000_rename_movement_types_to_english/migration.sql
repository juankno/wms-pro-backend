ALTER TYPE "MovementType" RENAME VALUE 'inventario_inicial' TO 'opening_balance';
ALTER TYPE "MovementType" RENAME VALUE 'entrada_compra' TO 'purchase_receipt';
ALTER TYPE "MovementType" RENAME VALUE 'entrada_devolucion' TO 'customer_return';
ALTER TYPE "MovementType" RENAME VALUE 'entrada_traslado' TO 'transfer_in';
ALTER TYPE "MovementType" RENAME VALUE 'salida_picking' TO 'order_shipment';
ALTER TYPE "MovementType" RENAME VALUE 'salida_traslado' TO 'transfer_out';
ALTER TYPE "MovementType" RENAME VALUE 'ajuste_positivo' TO 'adjustment_increase';
ALTER TYPE "MovementType" RENAME VALUE 'ajuste_negativo' TO 'adjustment_decrease';
