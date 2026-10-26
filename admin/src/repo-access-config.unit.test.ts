/**
 * admin/src/repo-access-config.unit.test.ts
 * Pure flag parser for the per-repo GitHub access check (COS-44.1).
 */

import { describe, expect, it } from "bun:test";
import { parseRepoAccessConfig } from "./repo-access-config.ts";

describe("parseRepoAccessConfig", () => {
  it('is on only for the literal "enabled"', () => {
    expect(
      parseRepoAccessConfig({
        SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED: "enabled",
      }).enabled,
    ).toBe(true);
  });

  it("every other value is off", () => {
    for (const v of [
      "true",
      "",
      "Enabled",
      " enabled",
      "disabled",
      undefined,
    ]) {
      expect(
        parseRepoAccessConfig({ SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED: v })
          .enabled,
      ).toBe(false);
    }
    expect(parseRepoAccessConfig({}).enabled).toBe(false);
  });
});
