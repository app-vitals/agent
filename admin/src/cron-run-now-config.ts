/**
 * admin/src/cron-run-now-config.ts
 *
 * Pure parser for the cron run-now flag (COS-42.1). Takes an injected env
 * object (no process.env reads) so it is deterministically unit-testable;
 * admin-boot reads it once at startup and injects the resolved config as
 * deps. Same "enabled" convention as the agent-ask and self-serve flags.
 */

/** Structural env shape — accepts `process.env` or a plain test object. */
type CronRunNowEnv = Readonly<Record<string, string | undefined>>;

export interface CronRunNowConfig {
  /** True only when SHIPWRIGHT_CRON_RUN_NOW_ENABLED === "enabled". */
  enabled: boolean;
}

export function parseCronRunNowConfig(env: CronRunNowEnv): CronRunNowConfig {
  return { enabled: env.SHIPWRIGHT_CRON_RUN_NOW_ENABLED === "enabled" };
}
