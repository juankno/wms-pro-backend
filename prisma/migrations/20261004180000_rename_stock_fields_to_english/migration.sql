ALTER TABLE "warehouse_stock" RENAME COLUMN "stockFisico" TO "onHand";
ALTER TABLE "warehouse_stock" RENAME COLUMN "stockReservado" TO "reserved";

ALTER TABLE "warehouse_stock" RENAME CONSTRAINT "warehouse_stock_stock_fisico_non_negative" TO "warehouse_stock_on_hand_non_negative";
ALTER TABLE "warehouse_stock" RENAME CONSTRAINT "warehouse_stock_stock_reservado_non_negative" TO "warehouse_stock_reserved_non_negative";
ALTER TABLE "warehouse_stock" RENAME CONSTRAINT "warehouse_stock_reservado_within_fisico" TO "warehouse_stock_reserved_within_on_hand";

ALTER TABLE "stock_movements" RENAME COLUMN "stockFisicoAntes" TO "onHandBefore";
ALTER TABLE "stock_movements" RENAME COLUMN "stockFisicoDespues" TO "onHandAfter";
ALTER TABLE "stock_movements" RENAME COLUMN "stockReservadoAntes" TO "reservedBefore";
ALTER TABLE "stock_movements" RENAME COLUMN "stockReservadoDespues" TO "reservedAfter";
