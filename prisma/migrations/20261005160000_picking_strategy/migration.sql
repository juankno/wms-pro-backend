-- CreateEnum
CREATE TYPE "PickingStrategy" AS ENUM ('fefo', 'fifo', 'lifo');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "pickingStrategy" "PickingStrategy";
