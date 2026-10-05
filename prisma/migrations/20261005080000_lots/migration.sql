-- AlterTable
ALTER TABLE "products" ADD COLUMN     "lotTracking" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "lotId" TEXT;

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_stock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lot_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "picking_item_lots" (
    "id" TEXT NOT NULL,
    "pickingItemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "picking_item_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lots_tenantId_expiresAt_idx" ON "lots"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "lots_productId_code_key" ON "lots"("productId", "code");

-- CreateIndex
CREATE INDEX "lot_stock_tenantId_warehouseId_productId_idx" ON "lot_stock"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "lot_stock_lotId_warehouseId_key" ON "lot_stock"("lotId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "picking_item_lots_pickingItemId_lotId_key" ON "picking_item_lots"("pickingItemId", "lotId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_stock" ADD CONSTRAINT "lot_stock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_stock" ADD CONSTRAINT "lot_stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_stock" ADD CONSTRAINT "lot_stock_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_stock" ADD CONSTRAINT "lot_stock_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_item_lots" ADD CONSTRAINT "picking_item_lots_pickingItemId_fkey" FOREIGN KEY ("pickingItemId") REFERENCES "picking_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_item_lots" ADD CONSTRAINT "picking_item_lots_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lot_stock" ADD CONSTRAINT "lot_stock_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "picking_item_lots" ADD CONSTRAINT "picking_item_lots_quantity_non_negative" CHECK ("quantity" >= 0);
