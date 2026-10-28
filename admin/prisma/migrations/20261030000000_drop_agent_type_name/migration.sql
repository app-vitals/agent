-- AGR-6.3: REMOVE step of the typeName -> specialty rename.
-- Backfill any row AGR-6.1/6.2 missed (specialty still NULL) from typeName,
-- make specialty required (default 'coding', matching the old typeName
-- default), then drop the legacy typeName column.
UPDATE "Agent" SET "specialty" = "typeName" WHERE "specialty" IS NULL;
ALTER TABLE "Agent" ALTER COLUMN "specialty" SET DEFAULT 'coding';
ALTER TABLE "Agent" ALTER COLUMN "specialty" SET NOT NULL;
ALTER TABLE "Agent" DROP COLUMN "typeName";
