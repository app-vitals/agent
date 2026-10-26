/**
 * admin/src/transcript-config.ts
 *
 * Pure parser for the cron-run transcript API flag (COS-43.1). Takes an
 * injected env object (no process.env reads) so it is deterministically
 * unit-testable; admin-boot reads it once at startup and injects the result.
 * Same "enabled" convention as agent-ask-config.ts.
 */

type TranscriptEnv = Readonly<Record<string, string | undefined>>;

export interface TranscriptConfig {
  /** True only when SHIPWRIGHT_TRANSCRIPT_API_ENABLED === "enabled". */
  enabled: boolean;
}

export function parseTranscriptConfig(env: TranscriptEnv): TranscriptConfig {
  return { enabled: env.SHIPWRIGHT_TRANSCRIPT_API_ENABLED === "enabled" };
}
