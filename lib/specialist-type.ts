/**
 * lib/specialist-type.ts
 *
 * The platform's one built-in agent type, as a plain typed record. Replaces
 * the former agent-types/specialist/manifest.yaml (and its strict Zod
 * schema/loader): the values below are exactly what that manifest declared
 * and that anything still read from it. Shared by admin (tools floor,
 * required-env reporting, type validity) and runtime (template lookup).
 */

export interface SpecialtyType {
  /** The value stored in Agent.specialty. */
  name: string;
  displayName: string;
  /** Workspace template directory, relative to the repo/image root. */
  templatesDir: string;
  /** Tool patterns seeded as AgentTool rows on create. */
  tools: readonly string[];
  /** Env keys an agent of this type must have; reported when missing. */
  requiredEnv: readonly string[];
}

export const SPECIALIST_TYPE: SpecialtyType = {
  name: "specialist",
  displayName: "Specialist Agent",
  templatesDir: "agent-types/specialist/templates/",
  tools: ["Bash", "WebSearch", "WebFetch", "Agent"],
  requiredEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
};
