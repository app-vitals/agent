/**
 * Contract test: the specialist type record carries the exact values the
 * retired agent-types/specialist/manifest.yaml declared, so existing
 * specialist agents keep the same tools floor, required-env reporting and
 * template seeding.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPECIALIST_TYPE } from "./specialist-type.ts";

describe("SPECIALIST_TYPE", () => {
  it("keeps the old manifest's identity and tools floor", () => {
    expect(SPECIALIST_TYPE.name).toBe("specialist");
    expect(SPECIALIST_TYPE.displayName).toBe("Specialist Agent");
    expect([...SPECIALIST_TYPE.tools]).toEqual([
      "Bash",
      "WebSearch",
      "WebFetch",
      "Agent",
    ]);
  });

  it("keeps the old manifest's required env keys", () => {
    expect([...SPECIALIST_TYPE.requiredEnv]).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("points templatesDir at the shipped specialist templates", () => {
    expect(SPECIALIST_TYPE.templatesDir).toBe(
      "agent-types/specialist/templates/",
    );
    const dir = join(import.meta.dir, "..", SPECIALIST_TYPE.templatesDir);
    for (const f of [
      "CLAUDE.md.template",
      "SOUL.md.template",
      "IDENTITY.md.template",
      "SPECIALTY.md.template",
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });
});
