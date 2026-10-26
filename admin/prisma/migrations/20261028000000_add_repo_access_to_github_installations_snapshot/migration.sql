-- COS-44.1: per-repo GitHub access probe result reported by the runtime.
-- Nullable and additive; no token or credential is ever stored here.
ALTER TABLE "AgentGitHubInstallationsSnapshot" ADD COLUMN "repoAccess" JSONB;
