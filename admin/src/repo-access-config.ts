/**
 * admin/src/repo-access-config.ts
 *
 * Pure parser for the per-repo GitHub access check flag (COS-44.1). Takes an
 * injected env object (no process.env reads) so it is deterministically
 * unit-testable; admin-boot reads it once at startup and feeds it into the
 * config bundle as `features.repoAccessCheck`. Same "enabled" convention as
 * transcript-config.ts.
 */

type RepoAccessEnv = Readonly<Record<string, string | undefined>>;

export interface RepoAccessConfig {
  /** True only when SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED === "enabled". */
  enabled: boolean;
}

export function parseRepoAccessConfig(env: RepoAccessEnv): RepoAccessConfig {
  return {
    enabled: env.SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED === "enabled",
  };
}
