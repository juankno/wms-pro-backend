-- CreateEnum
CREATE TYPE "CycleCountStatus" AS ENUM ('open', 'submitted', 'approved', 'cancelled');

-- CreateTable
CREATE TABLE "cycle_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "CycleCountStatus" NOT NULL DEFAULT 'open',
    "blind" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "cycle_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_count_lines" (
    "id" TEXT NOT NULL,
    "cycleCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "lotCode" TEXT,
    "countedById" TEXT,
    "countedAt" TIMESTAMP(3),

    CONSTRAINT "cycle_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cycle_counts_tenantId_status_idx" ON "cycle_counts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_counts_tenantId_reference_key" ON "cycle_counts"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "cycle_count_lines_cycleCountId_idx" ON "cycle_count_lines"("cycleCountId");

-- AddForeignKey
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_cycleCountId_fkey" FOREIGN KEY ("cycleCountId") REFERENCES "cycle_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cycle_count_lines"
  ADD CONSTRAINT "cycle_count_lines_expected_non_negative" CHECK ("expectedQuantity" >= 0),
  ADD CONSTRAINT "cycle_count_lines_counted_non_negative" CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);
