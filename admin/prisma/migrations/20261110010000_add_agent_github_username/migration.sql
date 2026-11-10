-- GHE-2.1: GitHub account whose repo access caps the agent. Additive only: one nullable column, existing agents keep NULL.
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "githubUsername" TEXT;
