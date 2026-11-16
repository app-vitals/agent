-- Surrogate primary key: existing rows (the deployment-wide pair) get a
-- deterministic id derived from their role; no data is otherwise touched.
ALTER TABLE "GitHubEnterpriseApp" DROP CONSTRAINT "GitHubEnterpriseApp_pkey";
ALTER TABLE "GitHubEnterpriseApp" ADD COLUMN "id" TEXT;
UPDATE "GitHubEnterpriseApp" SET "id" = 'ghe_' || "role";
ALTER TABLE "GitHubEnterpriseApp" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "GitHubEnterpriseApp" ADD CONSTRAINT "GitHubEnterpriseApp_pkey" PRIMARY KEY ("id");

-- Nullable account scope; existing rows stay NULL (deployment-wide).
ALTER TABLE "GitHubEnterpriseApp" ADD COLUMN "accountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "GitHubEnterpriseApp_accountId_role_key" ON "GitHubEnterpriseApp"("accountId", "role");

-- AddForeignKey
ALTER TABLE "GitHubEnterpriseApp" ADD CONSTRAINT "GitHubEnterpriseApp_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index (not expressible in Prisma; see the GitHubEnterpriseApp
-- comment in schema.prisma). The plain (accountId, role) index above cannot
-- enforce one deployment-wide row per role because NULLs compare distinct.
CREATE UNIQUE INDEX "GitHubEnterpriseApp_role_global_key" ON "GitHubEnterpriseApp"("role") WHERE "accountId" IS NULL;
