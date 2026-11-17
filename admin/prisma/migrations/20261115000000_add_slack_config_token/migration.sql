-- SlackConfigToken: Slack app-configuration token per scope (account or
-- deployment-wide default). Additive only: one new table.
-- CreateTable
CREATE TABLE "SlackConfigToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "slackTeamId" TEXT,
    "slackUserId" TEXT,
    "lastRotatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackConfigToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlackConfigToken_accountId_idx" ON "SlackConfigToken"("accountId");

-- AddForeignKey
ALTER TABLE "SlackConfigToken" ADD CONSTRAINT "SlackConfigToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique indexes (not expressible in Prisma; see the SlackConfigToken
-- comment in schema.prisma). Together they allow at most one row per scope with
-- NULL treated as a value, which a plain UNIQUE index would not do since NULLs
-- compare distinct.
-- CreateIndex
CREATE UNIQUE INDEX "SlackConfigToken_accountId_key" ON "SlackConfigToken"("accountId") WHERE "accountId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SlackConfigToken_global_key" ON "SlackConfigToken"((1)) WHERE "accountId" IS NULL;
