-- GHE-1.1: optional admin-level GitHub Apps (installer / lookup). Additive only: new table.
-- CreateTable
CREATE TABLE "GitHubEnterpriseApp" (
    "role" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enterpriseSlug" TEXT,
    "privateKeyEncrypted" TEXT NOT NULL,
    "lastValidationStatus" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubEnterpriseApp_pkey" PRIMARY KEY ("role")
);
