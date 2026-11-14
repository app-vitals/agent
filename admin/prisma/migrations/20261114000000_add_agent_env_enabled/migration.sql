-- ATP-1.2: AgentEnv tombstones. Additive only: existing rows get enabled = true.
-- AlterTable
ALTER TABLE "AgentEnv" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;
