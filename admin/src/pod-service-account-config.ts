/**
 * admin/src/pod-service-account-config.ts
 *
 * Pure parser for the per-agent pod ServiceAccount flag (COS-48.1). Takes an
 * injected env object (no process.env reads) so it is deterministically
 * unit-testable; admin-boot-config threads the resolved config into the
 * provisioner. Same "enabled" convention as agent-ask-config.ts.
 */

/** Structural env shape — accepts `process.env` or a plain test object. */
type PodServiceAccountEnv = Readonly<Record<string, string | undefined>>;

export interface PodServiceAccountConfig {
  /** True only when SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED === "enabled". */
  enabled: boolean;
}

export function parsePodServiceAccountConfig(
  env: PodServiceAccountEnv,
): PodServiceAccountConfig {
  return {
    enabled: env.SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED === "enabled",
  };
}
