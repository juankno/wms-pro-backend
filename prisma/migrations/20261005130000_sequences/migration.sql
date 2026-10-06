-- CreateTable
CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sequences_tenantId_key_key" ON "sequences"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sequences"
  ADD CONSTRAINT "sequences_next_value_positive" CHECK ("nextValue" > 0),
  ADD CONSTRAINT "sequences_padding_range" CHECK ("padding" BETWEEN 1 AND 10);
