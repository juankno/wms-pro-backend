ALTER TABLE "warehouse_stock"
  ADD CONSTRAINT "warehouse_stock_stock_fisico_non_negative" CHECK ("stockFisico" >= 0),
  ADD CONSTRAINT "warehouse_stock_stock_reservado_non_negative" CHECK ("stockReservado" >= 0),
  ADD CONSTRAINT "warehouse_stock_reservado_within_fisico" CHECK ("stockReservado" <= "stockFisico"),
  ADD CONSTRAINT "warehouse_stock_min_stock_non_negative" CHECK ("minStock" >= 0);
