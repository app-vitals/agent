-- GLC-1.1: GitHub repo/access cache. Additive only: three new tables, nothing existing is touched.
-- CreateTable
CREATE TABLE "GitHubRepoSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "appKind" TEXT NOT NULL,
    "appRef" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "crawlPage" INTEGER NOT NULL DEFAULT 0,
    "crawlStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalCount" INTEGER,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "rateLimitResetAt" TIMESTAMP(3),
    "leaseHolder" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "lastTickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubRepoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubCachedRepo" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubCachedRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubRepoAccess" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "canPush" BOOLEAN NOT NULL DEFAULT false,
    "level" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GitHubRepoAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubRepoSnapshot_accountId_appKind_org_idx" ON "GitHubRepoSnapshot"("accountId", "appKind", "org");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepoSnapshot_accountId_appKind_appRef_org_key" ON "GitHubRepoSnapshot"("accountId", "appKind", "appRef", "org");

-- CreateIndex
CREATE INDEX "GitHubCachedRepo_snapshotId_seenAt_idx" ON "GitHubCachedRepo"("snapshotId", "seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubCachedRepo_snapshotId_githubId_key" ON "GitHubCachedRepo"("snapshotId", "githubId");

-- CreateIndex
CREATE INDEX "GitHubRepoAccess_accountId_org_username_nextAttemptAt_idx" ON "GitHubRepoAccess"("accountId", "org", "username", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepoAccess_accountId_org_repo_username_key" ON "GitHubRepoAccess"("accountId", "org", "repo", "username");

-- AddForeignKey
ALTER TABLE "GitHubCachedRepo" ADD CONSTRAINT "GitHubCachedRepo_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "GitHubRepoSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
