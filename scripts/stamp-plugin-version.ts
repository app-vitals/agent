#!/usr/bin/env bun
/**
 * scripts/stamp-plugin-version.ts
 *
 * Stamps the release version into the baked agent-platform plugin's
 * plugin.json. Claude Code only refreshes an installed plugin when its version
 * changes, so the publish-image job stamps every release instead of requiring
 * a hand bump on each content change. The checked-in version is a placeholder.
 *
 * Usage: bun scripts/stamp-plugin-version.ts X.Y.Z [pluginJsonPath]
 */

import { readFileSync, writeFileSync } from "node:fs";

export const PLUGIN_JSON = "plugins/agent-platform/.claude-plugin/plugin.json";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export function stampPluginVersion(
  version: string,
  path: string = PLUGIN_JSON,
): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`'${version}' is not an X.Y.Z version`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  const [version, path] = process.argv.slice(2);
  if (!version) {
    console.error("Usage: bun scripts/stamp-plugin-version.ts X.Y.Z [path]");
    process.exit(1);
  }
  try {
    stampPluginVersion(version, path);
    console.log(`Stamped agent-platform plugin version ${version}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
