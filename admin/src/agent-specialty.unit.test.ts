/**
 * Unit tests for the AGR-6.1 specialty mapper (typeName -> specialty ADD step).
 */

import { describe, expect, it } from "bun:test";
import { resolveSpecialty, withResolvedSpecialty } from "./agent-specialty.ts";

describe("resolveSpecialty", () => {
  it("prefers specialty when set", () => {
    expect(
      resolveSpecialty({ typeName: "coding", specialty: "research" }),
    ).toBe("research");
  });

  it("falls back to typeName when specialty is null", () => {
    expect(resolveSpecialty({ typeName: "coding", specialty: null })).toBe(
      "coding",
    );
  });

  it("falls back to typeName when specialty is absent", () => {
    expect(resolveSpecialty({ typeName: "coding" })).toBe("coding");
  });

  it("does not treat an empty-string specialty as unset", () => {
    expect(resolveSpecialty({ typeName: "coding", specialty: "" })).toBe("");
  });
});

describe("withResolvedSpecialty", () => {
  it("returns a copy with specialty resolved and typeName preserved", () => {
    const row = { id: "a1", typeName: "coding", specialty: null };
    const out = withResolvedSpecialty(row);
    expect(out).toEqual({ id: "a1", typeName: "coding", specialty: "coding" });
    expect(row.specialty).toBeNull();
  });

  it("keeps an explicit specialty", () => {
    expect(
      withResolvedSpecialty({ typeName: "coding", specialty: "research" }),
    ).toEqual({ typeName: "coding", specialty: "research" });
  });
});
