/**
 * runtime/agent-features-ref.ts
 *
 * A tiny mutable box holding the `features` object from the most recently
 * synced config bundle (COS-43.1), so consumers such as the transcript
 * uploader read a live view without closing over one syncConfig() tick.
 * Absent until the first successful sync (and when talking to an older admin
 * that does not send `features`) — consumers treat that as "all off".
 */

export interface AgentFeatures {
  transcriptUpload?: boolean;
  repoAccessCheck?: boolean;
}

export interface AgentFeaturesRef {
  get(): AgentFeatures | undefined;
  set(features: AgentFeatures | undefined): void;
}

export function createAgentFeaturesRef(): AgentFeaturesRef {
  let current: AgentFeatures | undefined;
  return {
    get: () => current,
    set(features) {
      current = features;
    },
  };
}

/** Process-wide ref written by boot's syncConfig() on every successful tick. */
export const agentFeaturesRef: AgentFeaturesRef = createAgentFeaturesRef();
