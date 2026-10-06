-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('purchase', 'customer_return');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('restock', 'scrap');

-- AlterTable
ALTER TABLE "receipt_lines" ADD COLUMN     "disposition" "ReturnDisposition" NOT NULL DEFAULT 'restock';

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "kind" "ReceiptKind" NOT NULL DEFAULT 'purchase',
ADD COLUMN     "pickingOrderId" TEXT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_pickingOrderId_fkey" FOREIGN KEY ("pickingOrderId") REFERENCES "picking_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
