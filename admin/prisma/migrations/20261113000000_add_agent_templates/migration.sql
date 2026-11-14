-- ATP-1.1: agent templates and row source markers. Additive only: two new
-- tables, plus new columns with defaults on existing tables (existing rows get
-- source = 'custom', templateDetached = false, AgentTool.updatedAt = now).
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "templateDetached" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AgentCronJob" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'custom';

-- AlterTable
ALTER TABLE "AgentEnv" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'custom';

-- AlterTable
ALTER TABLE "AgentPlugin" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'custom';

-- AlterTable
ALTER TABLE "AgentTool" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'custom',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "AgentTemplate" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "specialty" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTemplate_accountId_idx" ON "AgentTemplate"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplateItem_templateId_kind_key_key" ON "AgentTemplateItem"("templateId", "kind", "key");

-- AddForeignKey
ALTER TABLE "AgentTemplate" ADD CONSTRAINT "AgentTemplate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTemplateItem" ADD CONSTRAINT "AgentTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial unique indexes (not expressible in Prisma; see the AgentTemplate
-- comment in schema.prisma). Together they allow at most one template per
-- (accountId, specialty) pair with NULL treated as a value, which a plain
-- UNIQUE index would not do since NULLs compare distinct.
-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_accountId_specialty_key" ON "AgentTemplate"("accountId", "specialty") WHERE "accountId" IS NOT NULL AND "specialty" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_specialty_global_key" ON "AgentTemplate"("specialty") WHERE "accountId" IS NULL AND "specialty" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_accountId_any_key" ON "AgentTemplate"("accountId") WHERE "accountId" IS NOT NULL AND "specialty" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_global_any_key" ON "AgentTemplate"((1)) WHERE "accountId" IS NULL AND "specialty" IS NULL;
