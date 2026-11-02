/**
 * Platform-only boot against the REAL shipped agent-types/ directory with an
 * empty environment (PCD-3.1). Env is passed explicitly: the test preload
 * presets fixture env vars on process.env, so nothing here reads it.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SpecialtyTypes } from "@app-vitals/agent-admin/specialty-types";
import {
  resolveDefaultSpecialtyName,
  SHIPPED_AGENT_TYPES_DIR,
} from "@app-vitals/agent-lib/default-specialty";
import { SPECIALIST_TYPE } from "@app-vitals/agent-lib/specialist-type";
import { resolveTemplatesDir } from "./setup.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("platform-only boot with empty env", () => {
  it("the default type resolves to the built-in specialist type", () => {
    const defaultName = resolveDefaultSpecialtyName(EMPTY_ENV);
    const types = new SpecialtyTypes({ defaultTypeName: defaultName });
    expect(defaultName).toBe("specialist");
    expect(types.tryGetType(defaultName)).toBe(SPECIALIST_TYPE);
    expect(types.listTypes().map((t) => t.name)).toEqual(["specialist"]);
  });

  it("a stored legacy type still resolves to the specialist floor, but is not a valid new type", () => {
    const types = new SpecialtyTypes({ defaultTypeName: "specialist" });
    expect(types.getType("no-such-type")).toBe(SPECIALIST_TYPE);
    expect(types.tryGetType("no-such-type")).toBeUndefined();
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
    expect(dir).toBe(
      join(import.meta.dir, "..", SPECIALIST_TYPE.templatesDir).replace(
        /\/$/,
        "",
      ),
    );
    expect(existsSync(join(dir, "CLAUDE.md.template"))).toBe(true);
  });
});
