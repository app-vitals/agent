import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

describe("lib/package.json exports", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (target.includes("*")) continue;
    test(`${subpath} target exists on disk`, () => {
      expect(existsSync(join(import.meta.dir, target))).toBe(true);
    });
  }

  test("every non-wildcard export imports cleanly", async () => {
    for (const [, target] of Object.entries(pkg.exports)) {
      if (target.includes("*")) continue;
      const mod = await import(join(import.meta.dir, target));
      expect(typeof mod).toBe("object");
    }
  });
});
