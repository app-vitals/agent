/**
 * admin/src/brand-tokens.unit.test.ts
 * brand-tokens.json must be valid JSON in the agreed color(+font)-only schema
 * and be exported from the package's exports map.
 */

import { describe, expect, it } from "bun:test";
import pkg from "../package.json";
import tokens from "./brand-tokens.json";

const HEX = /^#[0-9a-fA-F]{6}$/;

function leaves(node: unknown, path: string[] = []): [string, unknown][] {
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  return [[path.join("."), node]];
}

describe("brand-tokens.json", () => {
  it("has only color and font top-level groups (plus $comment)", () => {
    expect(Object.keys(tokens).filter((k) => k !== "$comment")).toEqual([
      "color",
      "font",
    ]);
  });

  it("every color leaf is a 6-digit hex string", () => {
    const colors = leaves(tokens.color);
    expect(colors.length).toBeGreaterThan(0);
    for (const [path, value] of colors) {
      expect(typeof value, path).toBe("string");
      expect(value as string, path).toMatch(HEX);
    }
  });

  it("every font leaf is a non-empty string", () => {
    for (const [path, value] of leaves(tokens.font)) {
      expect(typeof value, path).toBe("string");
      expect((value as string).length, path).toBeGreaterThan(0);
    }
  });

  it("covers the status/badge families", () => {
    for (const k of ["success", "warning", "danger", "info", "violet", "teal"]) {
      expect(Object.keys(tokens.color), k).toContain(k);
    }
  });

  it("is exported via the package exports map", () => {
    expect(
      (pkg.exports as Record<string, string>)["./brand-tokens.json"],
    ).toBe("./src/brand-tokens.json");
  });
});
