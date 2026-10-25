/**
 * admin/src/agent-ask-config.ts
 *
 * Pure parser for the agent-to-agent ask flag and its allowlist (COS-31.1).
 * Takes an injected env object (no process.env reads) so it is
 * deterministically unit-testable; admin-boot reads it once at startup and
 * injects the resolved config as deps. Same "enabled" convention as the
 * self-serve flag (self-serve-config.ts).
 *
 * SHIPWRIGHT_AGENT_ASK_ALLOWLIST is a comma-separated list of directional
 * `from>to` agent-id pairs. Empty (or absent) denies every pair; a malformed
 * pair throws at boot, naming every offending entry.
 */

/** Structural env shape — accepts `process.env` or a plain test object. */
type AgentAskEnv = Readonly<Record<string, string | undefined>>;

export interface AgentAskConfig {
  /** True only when SHIPWRIGHT_AGENT_ASK_ENABLED === "enabled". */
  enabled: boolean;
  /** Allowed directional pairs, each stored as `from>to`. */
  allowlist: ReadonlySet<string>;
}

// One agent id on each side: no whitespace, no `>` and no `,`.
const PAIR_RE = /^([^\s>,]+)\s*>\s*([^\s>,]+)$/;

export function parseAgentAskConfig(env: AgentAskEnv): AgentAskConfig {
  const enabled = env.SHIPWRIGHT_AGENT_ASK_ENABLED === "enabled";
  const allowlist = new Set<string>();
  const malformed: string[] = [];
  for (const raw of (env.SHIPWRIGHT_AGENT_ASK_ALLOWLIST ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = PAIR_RE.exec(entry);
    if (!match) {
      malformed.push(entry);
      continue;
    }
    allowlist.add(`${match[1]}>${match[2]}`);
  }
  if (malformed.length > 0) {
    throw new Error(
      `[admin] invalid SHIPWRIGHT_AGENT_ASK_ALLOWLIST pair(s): ${malformed
        .map((p) => JSON.stringify(p))
        .join(", ")} (expected comma-separated from>to agent ids)`,
    );
  }
  return { enabled, allowlist };
}

/** Whether `from` may ask `to` (directional; empty allowlist denies all). */
export function isAskAllowed(
  config: Pick<AgentAskConfig, "allowlist">,
  from: string,
  to: string,
): boolean {
  return config.allowlist.has(`${from}>${to}`);
}
