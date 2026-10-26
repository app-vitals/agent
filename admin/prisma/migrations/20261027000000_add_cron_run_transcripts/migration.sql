-- COS-43.1: redacted cron-run transcripts + per-read audit rows (additive only).
-- CreateTable
CREATE TABLE "AgentCronRunTranscript" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "cronId" TEXT NOT NULL,
    "sessionId" TEXT,
    "bytes" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "redactions" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCronRunTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTranscriptRead" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "reader" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTranscriptRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCronRunTranscript_runId_key" ON "AgentCronRunTranscript"("runId");

-- CreateIndex
CREATE INDEX "AgentCronRunTranscript_agentId_createdAt_idx" ON "AgentCronRunTranscript"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTranscriptRead_agentId_at_idx" ON "AgentTranscriptRead"("agentId", "at");
