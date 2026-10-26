-- COS-42.1: cron run-now request columns and audit table (additive only).
-- AlterTable
ALTER TABLE "AgentCronJob" ADD COLUMN "runRequestedAt" TIMESTAMP(3),
ADD COLUMN "runRequestedBy" TEXT;

-- CreateTable
CREATE TABLE "AgentCronRunRequest" (
    "id" TEXT NOT NULL,
    "cronId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "honouredRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCronRunRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCronRunRequest_cronId_requestedAt_idx" ON "AgentCronRunRequest"("cronId", "requestedAt");

-- CreateIndex
CREATE INDEX "AgentCronRunRequest_agentId_requestedAt_idx" ON "AgentCronRunRequest"("agentId", "requestedAt");
