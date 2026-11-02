/**
 * docs/specialties.content.test.ts
 *
 * Content-layer test for docs/specialties.md and docs/agent-types.md: the
 * docs must describe the specialist type record's actual values and must not
 * mention the retired manifest apparatus (strict schema, YAML loader, JSON
 * Schema artifact).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SPECIALIST_TYPE } from "@app-vitals/agent-lib/specialist-type";

const read = (name: string) =>
  readFileSync(join(import.meta.dir, name), "utf-8");
const specialties = read("specialties.md");
const agentTypes = read("agent-types.md");

describe("docs/specialties.md", () => {
  it("documents the specialist record's values", () => {
    expect(specialties).toContain(SPECIALIST_TYPE.templatesDir);
    for (const tool of SPECIALIST_TYPE.tools)
      expect(specialties).toContain(`\`${tool}\``);
    for (const key of SPECIALIST_TYPE.requiredEnv)
      expect(specialties).toContain(key);
  });

  it("documents extension registration and type validity", () => {
    for (const term of [
      "agentTypes()",
      "specialtyDefaults(name)",
      "tryGetType",
      "getType",
      "FLOOR_TOOLS",
    ])
      expect(specialties).toContain(term);
  });
});

describe("retired manifest apparatus", () => {
  it("is gone from the docs", () => {
    for (const doc of [specialties, agentTypes]) {
      expect(doc).not.toContain("SpecialtyManifestSchema");
      expect(doc).not.toContain("specialty.schema.json");
      expect(doc).not.toContain("parseSpecialtyManifest");
      expect(doc).not.toContain("v1alpha1");
    }
  });

  it("is gone from the repository", () => {
    const root = join(import.meta.dir, "..");
    for (const path of [
      "agent-types/specialty.schema.json",
      "agent-types/specialist/manifest.yaml",
      "admin/src/specialty-registry.ts",
      "admin/src/specialty-manifest-loader.ts",
      "docs/specialties-examples.md",
      "docs/specialties-sources.md",
    ])
      expect(existsSync(join(root, path))).toBe(false);
  });
});
