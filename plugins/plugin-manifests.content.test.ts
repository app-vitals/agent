/**
 * plugins/plugin-manifests.content.test.ts
 *
 * Keeps the baked marketplace manifest, the plugin manifest and the runtime
 * Dockerfile COPY list in sync (no docker needed).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGINS_DIR = import.meta.dir;
const REPO_ROOT = join(PLUGINS_DIR, "..");
const MARKETPLACE_PATH = join(
  PLUGINS_DIR,
  ".claude-plugin",
  "marketplace.json",
);
const DOCKERFILE = readFileSync(
  join(REPO_ROOT, "runtime", "Dockerfile"),
  "utf8",
);

const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, "utf8")) as {
  name: string;
  plugins: { name: string; source: string }[];
};

describe("baked marketplace manifests", () => {
  test("marketplace is named app-vitals-agent", () => {
    expect(marketplace.name).toBe("app-vitals-agent");
  });

  test("each marketplace plugin has a plugin.json that agrees on name", () => {
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const entry of marketplace.plugins) {
      const manifest = join(
        PLUGINS_DIR,
        entry.source,
        ".claude-plugin",
        "plugin.json",
      );
      expect(existsSync(manifest), manifest).toBe(true);
      const plugin = JSON.parse(readFileSync(manifest, "utf8"));
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("slack-say skill and script ship in agent-platform", () => {
    const root = join(PLUGINS_DIR, "agent-platform");
    expect(existsSync(join(root, "skills", "slack-say", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(root, "scripts", "slack-say.ts"))).toBe(true);
  });

  test("Dockerfile copies the plugins dir from build into the marketplace root", () => {
    expect(DOCKERFILE).toMatch(/^COPY plugins\/ \.\/plugins\/$/m);
    expect(DOCKERFILE).toMatch(
      new RegExp(
        `^COPY --from=build --chown=1000:1000 /app/plugins ${"/opt/shipwright/marketplaces/"}${marketplace.name}/$`,
        "m",
      ),
    );
  });
});
