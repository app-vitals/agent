import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const spec = JSON.parse(
  readFileSync(
    new URL("../admin/openapi.platform.json", import.meta.url),
    "utf8",
  ),
) as { paths: Record<string, unknown> };

/** Top-level keys of the generated `paths` interface (4-space-indented quoted keys). */
function generatedPathKeys(): Set<string> {
  const src = readFileSync(new URL("./admin-types.ts", import.meta.url), "utf8");
  const start = src.indexOf("export interface paths {");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  return new Set(
    [...body.matchAll(/^ {4}"([^"]+)": \{$/gm)].map((m) => m[1] as string),
  );
}

describe("lib/admin-types.ts", () => {
  it("has every path in admin/openapi.platform.json as a key of the paths interface", () => {
    const generated = generatedPathKeys();
    const missing = Object.keys(spec.paths).filter((p) => !generated.has(p));
    expect(
      missing,
      `paths missing from lib/admin-types.ts: run \`bun run generate:admin-types\``,
    ).toEqual([]);
  });

  it("parses a non-empty set of generated paths", () => {
    expect(generatedPathKeys().size).toBeGreaterThan(0);
  });
});
