CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended');

CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- Existing single-company data moves to a default tenant.
INSERT INTO "tenants" ("id", "slug", "name", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default', CURRENT_TIMESTAMP);

ALTER TABLE "users"           ADD COLUMN "tenantId" TEXT;
ALTER TABLE "warehouses"      ADD COLUMN "tenantId" TEXT;
ALTER TABLE "products"        ADD COLUMN "tenantId" TEXT;
ALTER TABLE "warehouse_stock" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "stock_movements" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "picking_orders"  ADD COLUMN "tenantId" TEXT;
ALTER TABLE "packing_orders"  ADD COLUMN "tenantId" TEXT;
ALTER TABLE "activity_logs"   ADD COLUMN "tenantId" TEXT;

UPDATE "users"           SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "warehouses"      SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "products"        SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "warehouse_stock" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "stock_movements" SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "picking_orders"  SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "packing_orders"  SET "tenantId" = '00000000-0000-4000-8000-000000000001';
UPDATE "activity_logs"   SET "tenantId" = '00000000-0000-4000-8000-000000000001';

ALTER TABLE "users"           ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "warehouses"      ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "products"        ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "warehouse_stock" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "picking_orders"  ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "packing_orders"  ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "activity_logs"   ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX "packing_orders_reference_key";
DROP INDEX "picking_orders_reference_key";
DROP INDEX "products_barcode_key";
DROP INDEX "products_code_key";
DROP INDEX "users_email_key";
DROP INDEX "users_username_key";
DROP INDEX "warehouses_code_key";

CREATE INDEX "activity_logs_tenantId_timestamp_idx" ON "activity_logs"("tenantId", "timestamp" DESC);
CREATE UNIQUE INDEX "packing_orders_tenantId_reference_key" ON "packing_orders"("tenantId", "reference");
CREATE UNIQUE INDEX "picking_orders_tenantId_reference_key" ON "picking_orders"("tenantId", "reference");
CREATE UNIQUE INDEX "products_tenantId_code_key" ON "products"("tenantId", "code");
CREATE UNIQUE INDEX "products_tenantId_barcode_key" ON "products"("tenantId", "barcode");
CREATE INDEX "stock_movements_tenantId_createdAt_idx" ON "stock_movements"("tenantId", "createdAt" DESC);
CREATE UNIQUE INDEX "users_tenantId_username_key" ON "users"("tenantId", "username");
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");
CREATE UNIQUE INDEX "warehouses_tenantId_code_key" ON "warehouses"("tenantId", "code");

ALTER TABLE "users"           ADD CONSTRAINT "users_tenantId_fkey"           FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouses"      ADD CONSTRAINT "warehouses_tenantId_fkey"      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products"        ADD CONSTRAINT "products_tenantId_fkey"        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock" ADD CONSTRAINT "warehouse_stock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "picking_orders"  ADD CONSTRAINT "picking_orders_tenantId_fkey"  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "packing_orders"  ADD CONSTRAINT "packing_orders_tenantId_fkey"  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "activity_logs"   ADD CONSTRAINT "activity_logs_tenantId_fkey"   FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
