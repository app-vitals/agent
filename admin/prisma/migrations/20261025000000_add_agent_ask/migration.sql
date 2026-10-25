-- COS-31.1: AgentAsk audit table for agent-to-agent asks (additive only).
-- CreateTable
CREATE TABLE "AgentAsk" (
    "id" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL,
    "toAgentId" TEXT NOT NULL,
    "threadId" TEXT,
    "depth" INTEGER NOT NULL,
    "waitMs" INTEGER NOT NULL,
    "ttlSeconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "callerLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repliedAt" TIMESTAMP(3),

    CONSTRAINT "AgentAsk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAsk_toAgentId_createdAt_idx" ON "AgentAsk"("toAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAsk_fromAgentId_createdAt_idx" ON "AgentAsk"("fromAgentId", "createdAt");
