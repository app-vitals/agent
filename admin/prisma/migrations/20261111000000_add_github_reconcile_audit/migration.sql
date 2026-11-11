-- GHE-3.3: audit trail for GitHub repo reconcile applies. Additive only: one new table, nothing existing is touched.
-- CreateTable
CREATE TABLE "GitHubReconcileAudit" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubReconcileAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubReconcileAudit_agentId_createdAt_idx" ON "GitHubReconcileAudit"("agentId", "createdAt");
