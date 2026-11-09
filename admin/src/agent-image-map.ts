/**
 * admin/src/agent-image-map.ts
 *
 * Per-specialty agent image resolution (SPI-1.1). SHIPWRIGHT_AGENT_IMAGES is an
 * optional JSON object keyed by specialty whose values are `{repository, tag}`.
 * An agent whose specialty is unmapped (or has no specialty) runs the
 * single-image default (SHIPWRIGHT_AGENT_IMAGE / _TAG); a `default` key in the
 * map overrides that default. A malformed map throws, so admin boot fails
 * instead of silently falling back to the wrong image.
 */

export interface AgentImageRef {
  repository: string;
  tag: string;
}

export type AgentImageMap = Readonly<Record<string, AgentImageRef>>;

export const DEFAULT_IMAGE_KEY = "default";

function fail(reason: string): never {
  throw new Error(`SHIPWRIGHT_AGENT_IMAGES is malformed: ${reason}`);
}

/** Parse SHIPWRIGHT_AGENT_IMAGES. Unset/blank → undefined (single-image mode). */
export function parseAgentImageMap(
  raw: string | undefined,
): AgentImageMap | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("expected a JSON object keyed by specialty");
  }
  const map: Record<string, AgentImageRef> = {};
  for (const [specialty, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail(`"${specialty}" must be an object {repository, tag}`);
    }
    const { repository, tag } = value as Record<string, unknown>;
    if (typeof repository !== "string" || repository.trim() === "") {
      return fail(`"${specialty}".repository must be a non-empty string`);
    }
    if (typeof tag !== "string" || tag.trim() === "") {
      return fail(`"${specialty}".tag must be a non-empty string`);
    }
    map[specialty] = { repository, tag };
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * The image an agent of `specialty` runs: its own map entry, else the map's
 * `default` entry, else the single-image fallback.
 */
export function resolveImage(
  fallback: AgentImageRef,
  images: AgentImageMap | undefined,
  specialty?: string | null,
): AgentImageRef {
  if (!images) return fallback;
  const own =
    specialty && Object.hasOwn(images, specialty)
      ? images[specialty]
      : undefined;
  if (own) return own;
  return Object.hasOwn(images, DEFAULT_IMAGE_KEY)
    ? (images[DEFAULT_IMAGE_KEY] as AgentImageRef)
    : fallback;
}
