-- AddColumn: specialty TEXT (nullable) to Agent (additive, non-breaking).
-- AGR-6.1: ADD step of the typeName -> specialty rename. Backfill from typeName
-- so existing rows are consistent; reads still fall back to typeName when NULL.
ALTER TABLE "Agent" ADD COLUMN "specialty" TEXT;
UPDATE "Agent" SET "specialty" = "typeName";
