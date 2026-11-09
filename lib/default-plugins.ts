/**
 * lib/default-plugins.ts
 *
 * Plugins every newly created platform agent gets installed, whatever its
 * specialty. The baked marketplace only makes a plugin available; the
 * AgentPlugin rows decide what is installed. Seeded on create only, so
 * existing agents are unchanged.
 */

/** `<plugin>@<marketplace>`: the platform's own baked marketplace plugin. */
export const AGENT_PLATFORM_PLUGIN = "agent-platform@app-vitals-agent";

export const DEFAULT_PLATFORM_PLUGINS: readonly string[] = [
  AGENT_PLATFORM_PLUGIN,
];

/**
 * The create-time plugin set: the platform defaults followed by any
 * extension-supplied plugins, deduped, order preserved.
 */
export function resolveDefaultPlugins(
  extensionPlugins: readonly string[] = [],
): string[] {
  return [...new Set([...DEFAULT_PLATFORM_PLUGINS, ...extensionPlugins])];
}
