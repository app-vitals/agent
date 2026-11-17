-- TMK-3.2: AgentTemplateItem.managedBy marks items owned by a deployment
-- config source ('helm' = SHIPWRIGHT_TEMPLATE_SEED). Additive only: existing
-- rows stay NULL (hand-added) and the seed never touches them.
-- AlterTable
ALTER TABLE "AgentTemplateItem" ADD COLUMN     "managedBy" TEXT;
