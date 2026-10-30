-- PCD-3.4: change the Agent.specialty column default from 'coding' to 'specialist'.
-- Default only: no row rewrites, no constraint, no backfill, so every existing
-- agent keeps its stored value.
ALTER TABLE "Agent" ALTER COLUMN "specialty" SET DEFAULT 'specialist';
