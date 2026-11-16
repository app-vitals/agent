-- TMK-2.1: AgentMarketplace provenance and tombstones. Additive only: existing
-- rows get rowSource = 'custom' and enabled = true.
-- AlterTable
ALTER TABLE "AgentMarketplace" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rowSource" TEXT NOT NULL DEFAULT 'custom';
