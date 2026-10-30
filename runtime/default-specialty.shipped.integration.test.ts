/**
 * Platform-only boot against the REAL shipped agent-types/ directory with an
 * empty environment (PCD-3.1). Env is passed explicitly: the test preload
 * presets fixture env vars on process.env, so nothing here reads it.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SpecialtyRegistry } from "@app-vitals/agent-admin/specialty-manifest-loader";
import {
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
  SHIPPED_AGENT_TYPES_DIR,
} from "@app-vitals/agent-lib/default-specialty";
import { resolveTemplatesDir } from "./setup.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("platform-only boot with empty env", () => {
  it("SpecialtyRegistry resolves the default specialist type from the shipped agent-types/ without warning", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      typesDir: resolveSpecialtiesDir(EMPTY_ENV),
      defaultTypeName: resolveDefaultSpecialtyName(EMPTY_ENV),
      warn: (m) => warnings.push(m),
    });
    const manifest = registry.getManifest(
      resolveDefaultSpecialtyName(EMPTY_ENV),
    );
    expect(manifest.metadata.name).toBe("specialist");
    expect(warnings).toEqual([]);
    expect(registry.listTypes().map((t) => t.name)).toContain("specialist");
  });

  it("an unknown type warns and resolves to the shipped specialist manifest", () => {
    const warnings: string[] = [];
    const registry = new SpecialtyRegistry({
      typesDir: SHIPPED_AGENT_TYPES_DIR,
      defaultTypeName: "specialist",
      warn: (m) => warnings.push(m),
    });
    expect(registry.getManifest("no-such-type").metadata.name).toBe(
      "specialist",
    );
    expect(warnings).toHaveLength(1);
  });

  it("runtime resolveTemplatesDir agrees: the default type's shipped templates, no warning", () => {
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      undefined,
      join(import.meta.dir, ".."),
      (m) => warnings.push(m),
      EMPTY_ENV,
    );
    expect(warnings).toEqual([]);
    expect(dir).toBe(join(SHIPPED_AGENT_TYPES_DIR, "specialist", "templates"));
    expect(existsSync(join(dir, "CLAUDE.md.template"))).toBe(true);
  });
});
