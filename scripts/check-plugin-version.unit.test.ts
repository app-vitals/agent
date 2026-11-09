/**
 * scripts/check-plugin-version.unit.test.ts
 *
 * Unit tests for the agent-platform plugin version-bump gate.
 */

import { describe, expect, test } from "bun:test";
import { checkPluginVersion, PLUGIN_JSON } from "./check-plugin-version.ts";

const SKILL = "plugins/agent-platform/skills/slack-say/SKILL.md";

describe("checkPluginVersion", () => {
  test("passes when nothing under the plugin changed", () => {
    expect(
      checkPluginVersion({
        changedFiles: ["runtime/setup.ts"],
        baseVersion: "0.1.0",
        headVersion: "0.1.0",
      }).ok,
    ).toBe(true);
  });

  test("fails when plugin files change without a version bump", () => {
    const r = checkPluginVersion({
      changedFiles: [SKILL],
      baseVersion: "0.1.0",
      headVersion: "0.1.0",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("bump");
  });

  test("passes when plugin files change with a version bump", () => {
    expect(
      checkPluginVersion({
        changedFiles: [SKILL, PLUGIN_JSON],
        baseVersion: "0.1.0",
        headVersion: "0.1.1",
      }).ok,
    ).toBe(true);
  });

  test("accepts a brand-new plugin", () => {
    expect(
      checkPluginVersion({
        changedFiles: [PLUGIN_JSON],
        baseVersion: undefined,
        headVersion: "0.1.0",
      }).ok,
    ).toBe(true);
  });

  test("fails when plugin.json lacks a version", () => {
    expect(
      checkPluginVersion({
        changedFiles: [SKILL],
        baseVersion: "0.1.0",
        headVersion: undefined,
      }).ok,
    ).toBe(false);
  });
});
