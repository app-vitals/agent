-- COS-48.1: per-agent pod ServiceAccount. Nullable and additive; distinct from
-- k8sServiceAccountName (the Anthropic-federation ServiceAccount).
ALTER TABLE "Agent" ADD COLUMN "podServiceAccountName" TEXT;
