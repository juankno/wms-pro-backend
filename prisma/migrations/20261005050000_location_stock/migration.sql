-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'relocation';

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "toLocationId" TEXT;

-- AlterTable
ALTER TABLE "warehouse_stock" ADD COLUMN     "picked" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "location_stock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "location_stock_tenantId_warehouseId_productId_idx" ON "location_stock"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE INDEX "location_stock_locationId_idx" ON "location_stock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "location_stock_productId_locationId_key" ON "location_stock"("productId", "locationId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Stock integrity
ALTER TABLE "warehouse_stock"
  ADD CONSTRAINT "warehouse_stock_picked_non_negative" CHECK ("picked" >= 0),
  ADD CONSTRAINT "warehouse_stock_picked_within_on_hand" CHECK ("picked" <= "onHand");
ALTER TABLE "location_stock" ADD CONSTRAINT "location_stock_quantity_non_negative" CHECK ("quantity" >= 0);

-- Units already picked and not shipped are off the shelves.
UPDATE "warehouse_stock" ws SET "picked" = LEAST(sub.total, ws."onHand")
FROM (
  SELECT po."tenantId", po."warehouseId", pi."productId", SUM(pi."pickedQuantity")::int AS total
  FROM "picking_items" pi
  JOIN "picking_orders" po ON po.id = pi."pickingOrderId"
  LEFT JOIN "packing_orders" pk ON pk."pickingOrderId" = po.id
  WHERE po.status IN ('pending', 'in_progress')
     OR (po.status = 'completed' AND (pk.id IS NULL OR pk.status IN ('pending', 'in_progress')))
  GROUP BY po."tenantId", po."warehouseId", pi."productId"
) sub
WHERE ws."tenantId" = sub."tenantId" AND ws."warehouseId" = sub."warehouseId" AND ws."productId" = sub."productId";

-- Free-text locations become bin locations holding the stock that is on the shelves.
INSERT INTO "locations" (id, "tenantId", "warehouseId", code, type, storable, "updatedAt")
SELECT gen_random_uuid()::text, "tenantId", "warehouseId", UPPER(TRIM(location)), 'bin', true, CURRENT_TIMESTAMP
FROM "warehouse_stock"
WHERE TRIM(location) <> ''
GROUP BY "tenantId", "warehouseId", UPPER(TRIM(location))
ON CONFLICT ("warehouseId", code) DO NOTHING;

INSERT INTO "location_stock" (id, "tenantId", "productId", "warehouseId", "locationId", quantity, "updatedAt")
SELECT gen_random_uuid()::text, ws."tenantId", ws."productId", ws."warehouseId", l.id, ws."onHand" - ws."picked", CURRENT_TIMESTAMP
FROM "warehouse_stock" ws
JOIN "locations" l ON l."warehouseId" = ws."warehouseId" AND l.code = UPPER(TRIM(ws.location))
WHERE TRIM(ws.location) <> '' AND ws."onHand" - ws."picked" > 0;
