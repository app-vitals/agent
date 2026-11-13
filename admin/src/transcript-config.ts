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
  /**
   * Agent ids allowed to upload coding-loop run transcripts
   * (SHIPWRIGHT_LOOP_TRANSCRIPT_AGENT_IDS, comma-separated). Empty by default.
   */
  loopAgentIds: readonly string[];
}

export function parseTranscriptConfig(env: TranscriptEnv): TranscriptConfig {
  return {
    enabled: env.SHIPWRIGHT_TRANSCRIPT_API_ENABLED === "enabled",
    loopAgentIds: (env.SHIPWRIGHT_LOOP_TRANSCRIPT_AGENT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}
