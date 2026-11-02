/**
 * Specialist type contract + type validity (PCD-5.1).
 *
 * The expected values below are the retired
 * agent-types/specialist/manifest.yaml's, so existing specialist agents keep
 * the same tools floor, required-env reporting and template seeding.
 */

import { describe, expect, it } from "bun:test";
import { withExtensionAgentTypes } from "./admin-extension.ts";
import { SPECIALIST_TYPE, SpecialtyTypes } from "./specialty-types.ts";

describe("specialist type contract", () => {
  const types = new SpecialtyTypes({ defaultTypeName: "specialist" });

  it("resolves specialist to the old manifest's tools floor, required env and templatesDir", () => {
    const t = types.getType("specialist");
    expect([...t.tools]).toEqual(["Bash", "WebSearch", "WebFetch", "Agent"]);
    expect([...t.requiredEnv]).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(t.templatesDir).toBe("agent-types/specialist/templates/");
    expect(t).toBe(SPECIALIST_TYPE);
  });

  it("resolves every stored specialty (including legacy values) to the specialist floor", () => {
    for (const stored of ["specialist", "coding", "", "anything-old"]) {
      expect(types.getType(stored)).toBe(SPECIALIST_TYPE);
    }
  });

  it("rejects an unknown specialty on create-time validation", () => {
    expect(types.tryGetType("specialist")).toBe(SPECIALIST_TYPE);
    expect(types.tryGetType("nope")).toBeUndefined();
  });

  it("accepts the configured default type name", () => {
    const renamed = new SpecialtyTypes({ defaultTypeName: "base" });
    expect(renamed.tryGetType("base")).toBe(SPECIALIST_TYPE);
    expect(renamed.listTypes().map((t) => t.name)).toEqual([
      "specialist",
      "base",
    ]);
  });
});

describe("extension-registered types", () => {
  const wrapped = withExtensionAgentTypes(
    new SpecialtyTypes({ defaultTypeName: "specialist" }),
    [{ agentTypes: () => [{ name: "coding", displayName: "Coding Agent" }] }],
  );

  it("lists the extension type next to specialist", () => {
    expect(wrapped.listTypes()).toEqual([
      { name: "specialist", displayName: "Specialist Agent" },
      { name: "coding", displayName: "Coding Agent" },
    ]);
  });

  it("is accepted via hasExtensionType while still unknown to the built-in lookup", () => {
    expect(wrapped.tryGetType("coding")).toBeUndefined();
    expect(wrapped.hasExtensionType?.("coding")).toBe(true);
    expect(wrapped.hasExtensionType?.("nope")).toBe(false);
  });

  it("falls back to the specialist floor for its tools and required env", () => {
    expect(wrapped.getType("coding")).toBe(SPECIALIST_TYPE);
  });
});
