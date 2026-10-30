import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SPECIALTY_NAME,
  resolveDefaultSpecialtyName,
  resolveSpecialtiesDir,
  SHIPPED_AGENT_TYPES_DIR,
} from "./default-specialty.ts";

describe("default specialty resolution", () => {
  it("defaults to the shipped specialist type", () => {
    expect(DEFAULT_SPECIALTY_NAME).toBe("specialist");
    expect(resolveDefaultSpecialtyName({})).toBe("specialist");
  });

  it("defaults the specialties dir to the shipped agent-types/ directory", () => {
    expect(resolveSpecialtiesDir({})).toBe(SHIPPED_AGENT_TYPES_DIR);
    expect(SHIPPED_AGENT_TYPES_DIR).toBe(
      join(import.meta.dir, "..", "agent-types"),
    );
    expect(
      existsSync(join(SHIPPED_AGENT_TYPES_DIR, "specialist", "manifest.yaml")),
    ).toBe(true);
  });

  it("treats empty env values as unset", () => {
    expect(
      resolveDefaultSpecialtyName({ SHIPWRIGHT_DEFAULT_AGENT_TYPE: "" }),
    ).toBe("specialist");
    expect(resolveSpecialtiesDir({ SHIPWRIGHT_SPECIALTIES_DIR: "" })).toBe(
      SHIPPED_AGENT_TYPES_DIR,
    );
  });

  it("honours the env overrides", () => {
    expect(
      resolveDefaultSpecialtyName({ SHIPWRIGHT_DEFAULT_AGENT_TYPE: "base" }),
    ).toBe("base");
    expect(
      resolveSpecialtiesDir({ SHIPWRIGHT_SPECIALTIES_DIR: "/tmp/types" }),
    ).toBe("/tmp/types");
  });
});
