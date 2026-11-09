-- PMK-1.4: marketplaces baked into the agent image, reported by the runtime. Additive only: new column with a default.
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "bakedMarketplaces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
