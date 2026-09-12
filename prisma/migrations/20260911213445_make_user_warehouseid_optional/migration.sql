-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_warehouseId_fkey";

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "warehouseId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
