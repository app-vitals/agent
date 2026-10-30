/**
 * lib/default-specialty.ts
 *
 * The single source of truth for the platform's default agent type and the
 * directory its type definitions are loaded from. Shared by admin's
 * SpecialtyRegistry / account-agent-create and runtime's resolveTemplatesDir so
 * they can never disagree.
 *
 * Defaults are the platform's own: the `specialist` type under the shipped
 * `agent-types/` directory (present in the platform image at /app/agent-types).
 * SHIPWRIGHT_DEFAULT_AGENT_TYPE and SHIPWRIGHT_SPECIALTIES_DIR override them.
 */

import { join } from "node:path";

/** The universal fallback type, shipped under agent-types/. */
export const DEFAULT_SPECIALTY_NAME = "specialist";

/** The shipped agent-types/ directory (lib/ and agent-types/ are siblings). */
export const SHIPPED_AGENT_TYPES_DIR = join(
  import.meta.dir,
  "..",
  "agent-types",
);

/** SHIPWRIGHT_DEFAULT_AGENT_TYPE when set and non-empty, else "specialist". */
export function resolveDefaultSpecialtyName(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SHIPWRIGHT_DEFAULT_AGENT_TYPE || DEFAULT_SPECIALTY_NAME;
}

/** SHIPWRIGHT_SPECIALTIES_DIR when set and non-empty, else the shipped agent-types/. */
export function resolveSpecialtiesDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SHIPWRIGHT_SPECIALTIES_DIR || SHIPPED_AGENT_TYPES_DIR;
}
