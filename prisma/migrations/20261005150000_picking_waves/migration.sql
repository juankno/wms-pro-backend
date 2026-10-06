-- CreateEnum
CREATE TYPE "WaveStatus" AS ENUM ('open', 'completed', 'cancelled');

-- AlterTable
ALTER TABLE "picking_orders" ADD COLUMN     "waveId" TEXT;

-- CreateTable
CREATE TABLE "picking_waves" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "WaveStatus" NOT NULL DEFAULT 'open',
    "assignedToId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "picking_waves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "picking_waves_tenantId_status_idx" ON "picking_waves"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "picking_waves_tenantId_reference_key" ON "picking_waves"("tenantId", "reference");

-- AddForeignKey
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_waveId_fkey" FOREIGN KEY ("waveId") REFERENCES "picking_waves"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_waves" ADD CONSTRAINT "picking_waves_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_waves" ADD CONSTRAINT "picking_waves_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_waves" ADD CONSTRAINT "picking_waves_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "picking_waves" ADD CONSTRAINT "picking_waves_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
