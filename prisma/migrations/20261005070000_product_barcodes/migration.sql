-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_barcodes_productId_idx" ON "product_barcodes"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_tenantId_code_key" ON "product_barcodes"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_quantity_positive" CHECK ("quantity" > 0);
