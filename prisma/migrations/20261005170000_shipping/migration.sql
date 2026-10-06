-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('shipped', 'delivered');

-- CreateTable
CREATE TABLE "carriers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trackingUrlTemplate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packingOrderId" TEXT NOT NULL,
    "carrierId" TEXT,
    "carrierName" TEXT,
    "trackingNumber" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'shipped',
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedById" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "proofPhotoUrl" TEXT,
    "notes" TEXT,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carriers_tenantId_name_key" ON "carriers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_packingOrderId_key" ON "shipments"("packingOrderId");

-- CreateIndex
CREATE INDEX "shipments_tenantId_status_idx" ON "shipments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "shipments_tenantId_trackingNumber_idx" ON "shipments"("tenantId", "trackingNumber");

-- AddForeignKey
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_packingOrderId_fkey" FOREIGN KEY ("packingOrderId") REFERENCES "packing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "carriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shippedById_fkey" FOREIGN KEY ("shippedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
