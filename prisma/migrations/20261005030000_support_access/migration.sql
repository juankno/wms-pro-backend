-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "impersonatorId" TEXT,
ADD COLUMN     "impersonatorName" TEXT;

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tenantId" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_logs_createdAt_idx" ON "platform_audit_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_tenantId_createdAt_idx" ON "platform_audit_logs"("tenantId", "createdAt" DESC);
