/**
 * scripts/check-deps.unit.test.ts
 *
 * Unit tests for check-deps.ts: specifier parsing and the declared-dependency
 * gate over a temporary repository layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkDeps, extractImports, packageOf } from "./check-deps.ts";

/** Built at runtime so the boundary gate does not read it as a real edge. */
const REL = ".";

describe("packageOf", () => {
  test("returns the bare package name", () => {
    expect(packageOf("hono")).toBe("hono");
    expect(packageOf("ajv/dist/2020.js")).toBe("ajv");
  });

  test("keeps the scope on scoped packages", () => {
    expect(packageOf("@slack/bolt")).toBe("@slack/bolt");
    expect(packageOf("@app-vitals/agent-lib/sentry")).toBe(
      "@app-vitals/agent-lib",
    );
  });

  test("ignores node:/bun: builtins, bare Node builtins and bun", () => {
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("bun:test")).toBeNull();
    expect(packageOf("fs")).toBeNull();
    expect(packageOf("bun")).toBeNull();
  });

  test("ignores relative specifiers", () => {
    expect(packageOf("./check-deps.ts")).toBeNull();
    expect(packageOf("../scripts/check-deps.ts")).toBeNull();
  });
});

describe("extractImports", () => {
  test("flags only wholly type-only imports as type-only", () => {
    const src = [
      `import type { A } from "type-pkg";`,
      `import { type B, c } from "value-pkg";`,
      `import { D } from "mixed-pkg";`,
      `import type { E } from "mixed-pkg";`,
    ].join("\n");
    const byName = Object.fromEntries(
      extractImports(src).map((i) => [i.specifier, i.typeOnly]),
    );
    expect(byName).toEqual({
      "type-pkg": true,
      "value-pkg": false,
      "mixed-pkg": false,
    });
  });

  test("finds dynamic imports, require and mock.module", () => {
    const src = [
      `const a = await import("dyn-pkg");`,
      `const b = require("req-pkg");`,
      `mock.module("mocked-pkg", () => ({}));`,
    ].join("\n");
    expect(extractImports(src).map((i) => i.specifier)).toEqual([
      "dyn-pkg",
      "req-pkg",
      "mocked-pkg",
    ]);
  });
});

describe("checkDeps", () => {
  let root: string;

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  function manifest(rel: string, fields: Record<string, unknown>): void {
    write(rel, JSON.stringify({ name: "@x/pkg", ...fields }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-deps-"));
    manifest("package.json", {
      devDependencies: { "root-dev": "1.0.0" },
    });
    manifest("lib/package.json", {});
    manifest("admin/package.json", {});
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("passes when every import is declared", () => {
    manifest("runtime/package.json", { dependencies: { hono: "^4" } });
    write("runtime/a.ts", `import { Hono } from "hono";\n`);
    expect(checkDeps(root)).toEqual([]);
  });

  test("fails on an undeclared import", () => {
    manifest("runtime/package.json", { dependencies: {} });
    write("runtime/a.ts", `import { Hono } from "hono";\n`);
    const violations = checkDeps(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "runtime/a.ts",
      specifier: "hono",
      pkg: "hono",
    });
  });

  test("a devDependency does not satisfy a shipped value import", () => {
    manifest("runtime/package.json", { devDependencies: { hono: "^4" } });
    write("runtime/a.ts", `import { Hono } from "hono";\n`);
    expect(checkDeps(root)).toHaveLength(1);
  });

  test("a devDependency satisfies a type-only import", () => {
    manifest("runtime/package.json", { devDependencies: { hono: "^4" } });
    write("runtime/a.ts", `import type { Hono } from "hono";\n`);
    expect(checkDeps(root)).toEqual([]);
  });

  test("a root-only dependency does not satisfy a type-only import", () => {
    manifest("runtime/package.json", {});
    write("runtime/a.ts", `import type { X } from "root-dev";\n`);
    expect(checkDeps(root)).toHaveLength(1);
  });

  test("test files may use devDependencies and root-declared packages", () => {
    manifest("runtime/package.json", { devDependencies: { ajv: "^8" } });
    write("runtime/a.unit.test.ts", `import Ajv from "ajv";\n`);
    write("runtime/b.unit.test.ts", `import { x } from "root-dev";\n`);
    expect(checkDeps(root)).toEqual([]);
  });

  test("test files still fail on packages declared nowhere", () => {
    manifest("runtime/package.json", {});
    write("runtime/a.unit.test.ts", `import x from "nowhere";\n`);
    expect(checkDeps(root)).toHaveLength(1);
  });

  test("ignores node:/bun: builtins, bare builtins and relative imports", () => {
    manifest("runtime/package.json", {});
    write(
      "runtime/a.ts",
      [
        `import { readFileSync } from "node:fs";`,
        `import { join } from "path";`,
        `import { test } from "bun:test";`,
        `import { local } from "${REL}/b.ts";`,
      ].join("\n"),
    );
    expect(checkDeps(root)).toEqual([]);
  });

  test("sibling workspace packages must be declared too", () => {
    manifest("runtime/package.json", {});
    write(
      "runtime/a.ts",
      `import { s } from "@app-vitals/agent-lib/sentry";\n`,
    );
    expect(checkDeps(root)[0]).toMatchObject({ pkg: "@app-vitals/agent-lib" });
  });

  test("each package is checked against its own manifest", () => {
    manifest("runtime/package.json", { dependencies: { hono: "^4" } });
    write("runtime/a.ts", `import { Hono } from "hono";\n`);
    write("lib/b.ts", `import { Hono } from "hono";\n`);
    expect(checkDeps(root).map((v) => v.file)).toEqual(["lib/b.ts"]);
  });

  test("admin is scanned under src only", () => {
    manifest("runtime/package.json", {});
    write("admin/src/a.ts", `import x from "missing";\n`);
    write("admin/prisma/seed.ts", `import x from "also-missing";\n`);
    expect(checkDeps(root).map((v) => v.file)).toEqual(["admin/src/a.ts"]);
  });
});
