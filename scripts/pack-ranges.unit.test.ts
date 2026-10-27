import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMismatchedRanges, parseCli, rewriteRanges } from "./pack-ranges";

const manifest = {
  name: "@app-vitals/agent-admin",
  dependencies: {
    "@app-vitals/agent-lib": "workspace:*",
    "@app-vitals/agent-runtime": "0.1.0",
    zod: "^3.0.0",
  },
  devDependencies: {
    "@app-vitals/agent-lib": "workspace:^",
    biome: "workspace:*",
  },
};

describe("rewriteRanges", () => {
  test("pins every @app-vitals/* range and leaves other deps alone", () => {
    const out = rewriteRanges(manifest, "0.1.2");
    expect(out.dependencies).toEqual({
      "@app-vitals/agent-lib": "0.1.2",
      "@app-vitals/agent-runtime": "0.1.2",
      zod: "^3.0.0",
    });
    expect(out.devDependencies?.["@app-vitals/agent-lib"]).toBe("0.1.2");
    expect(out.devDependencies?.biome).toBe("workspace:*");
  });

  test("does not mutate its input", () => {
    rewriteRanges(manifest, "0.1.2");
    expect(manifest.dependencies["@app-vitals/agent-lib"]).toBe("workspace:*");
  });
});

describe("findMismatchedRanges", () => {
  test("reports ranges that differ from VERSION", () => {
    expect(findMismatchedRanges(manifest, "0.1.2")).toEqual([
      "dependencies.@app-vitals/agent-lib: workspace:* (expected 0.1.2)",
      "dependencies.@app-vitals/agent-runtime: 0.1.0 (expected 0.1.2)",
      "devDependencies.@app-vitals/agent-lib: workspace:^ (expected 0.1.2)",
    ]);
  });

  test("passes a rewritten manifest and manifests without internal deps", () => {
    expect(
      findMismatchedRanges(rewriteRanges(manifest, "0.1.2"), "0.1.2"),
    ).toEqual([]);
    expect(findMismatchedRanges({ name: "x" }, "0.1.2")).toEqual([]);
  });
});

describe("parseCli", () => {
  test("parses command, version and targets", () => {
    expect(
      parseCli(["assert", "--version", "1.2.3", "a.tgz", "b.tgz"]),
    ).toEqual({
      command: "assert",
      version: "1.2.3",
      targets: ["a.tgz", "b.tgz"],
    });
  });

  test("rejects missing version, unknown command, or no targets", () => {
    expect(() => parseCli(["assert", "a.tgz"])).toThrow();
    expect(() => parseCli(["nope", "--version", "1.0.0", "a"])).toThrow();
    expect(() => parseCli(["assert", "--version", "1.0.0"])).toThrow();
  });
});

describe("assert command (negative check)", () => {
  function packWith(range: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pack-ranges-test-"));
    const pkgDir = join(dir, "package");
    Bun.spawnSync(["mkdir", pkgDir]);
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "x",
        version: "0.1.2",
        dependencies: { "@app-vitals/agent-lib": range },
      }),
    );
    const tgz = join(dir, "x.tgz");
    Bun.spawnSync(["tar", "-czf", tgz, "-C", dir, "package"]);
    return tgz;
  }
  const run = (tgz: string) =>
    Bun.spawnSync([
      "bun",
      join(import.meta.dir, "pack-ranges.ts"),
      "assert",
      "--version",
      "0.1.2",
      tgz,
    ]);

  test("fails on a mismatched packed manifest", () => {
    expect(run(packWith("0.1.0")).exitCode).toBe(1);
  });

  test("passes on a matching packed manifest", () => {
    expect(run(packWith("0.1.2")).exitCode).toBe(0);
  });
});
