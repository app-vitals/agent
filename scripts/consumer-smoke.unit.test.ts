import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDockerRunArgs,
  buildProbeScript,
  deriveEntries,
  evaluateBoot,
  parseArgs,
  RESOLUTION_ERROR,
} from "./consumer-smoke.ts";

function fixture(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "consumer-smoke-unit-"));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

describe("deriveEntries", () => {
  test("non-wildcard modules are imported, the root entry maps to the bare name", () => {
    const entries = deriveEntries(
      "@app-vitals/x",
      { ".": "./src/server.ts", "./boot": "./boot.ts" },
      "/nonexistent",
    );
    expect(entries).toEqual([
      { specifier: "@app-vitals/x", mode: "import" },
      { specifier: "@app-vitals/x/boot", mode: "import" },
    ]);
  });

  test("json, package.json and prisma.config are resolved, not imported", () => {
    const entries = deriveEntries(
      "@app-vitals/x",
      {
        "./theme-tokens.json": "./src/theme-tokens.json",
        "./package.json": "./package.json",
        "./prisma.config": "./prisma.config.ts",
      },
      "/nonexistent",
    );
    expect(entries.map((e) => e.mode)).toEqual([
      "resolve",
      "resolve",
      "resolve",
    ]);
  });

  test("wildcards expand by globbing the source dir and skip tests", () => {
    const dir = fixture([
      "src/coding/a.ts",
      "src/coding/b.ts",
      "src/coding/a.unit.test.ts",
      "prisma/schema/schema.prisma",
      "prisma/migrations/001/migration.sql",
    ]);
    try {
      const entries = deriveEntries(
        "@app-vitals/x",
        {
          "./coding/*": "./src/coding/*.ts",
          "./prisma/schema/*": "./prisma/schema/*",
          "./prisma/migrations/*": "./prisma/migrations/*",
        },
        dir,
      );
      expect(entries).toEqual([
        { specifier: "@app-vitals/x/coding/a", mode: "import" },
        { specifier: "@app-vitals/x/coding/b", mode: "import" },
        {
          specifier: "@app-vitals/x/prisma/schema/schema.prisma",
          mode: "resolve",
        },
        {
          specifier: "@app-vitals/x/prisma/migrations/001/migration.sql",
          mode: "resolve",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wildcard matching nothing yields no entries", () => {
    const dir = fixture(["other.txt"]);
    try {
      expect(deriveEntries("@a/b", { "./c/*": "./src/c/*.ts" }, dir)).toEqual(
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildProbeScript", () => {
  test("embeds every specifier and its mode", () => {
    const script = buildProbeScript([
      { specifier: "@a/b/c", mode: "import" },
      { specifier: "@a/b/d.json", mode: "resolve" },
    ]);
    expect(script).toContain('"@a/b/c"');
    expect(script).toContain('"@a/b/d.json"');
    expect(script).toContain("process.exit(1)");
  });
});

describe("buildDockerRunArgs", () => {
  test("agent bypasses the env-checking entrypoint and runs index.ts", () => {
    const args = buildDockerRunArgs("agent", "agent:ci", "n");
    expect(args.slice(args.indexOf("--entrypoint"))).toEqual([
      "--entrypoint",
      "bun",
      "agent:ci",
      "run",
      "index.ts",
    ]);
    expect(args).toContain("AGENT_HOME=/tmp/agent-home");
  });

  test("admin keeps its image entrypoint", () => {
    const args = buildDockerRunArgs("admin", "admin:ci", "n");
    expect(args).not.toContain("--entrypoint");
    expect(args.at(-1)).toBe("admin:ci");
  });
});

describe("evaluateBoot", () => {
  test("passes when the readiness marker is logged", () => {
    expect(
      evaluateBoot("agent", {
        logs: "x [agent] agent home initialized: /h",
        exitCode: null,
      }).ok,
    ).toBe(true);
  });

  test("passes when admin reaches startAdmin then fails fast on missing config", () => {
    const r = evaluateBoot("admin", {
      logs: "[admin] starting admin service on port 3000\n[admin] fatal startup error: x",
      exitCode: 1,
    });
    expect(r.ok).toBe(true);
  });

  test("fails on module resolution errors even when the marker is present", () => {
    const logs =
      "[agent] agent home initialized\nerror: Cannot find module '@app-vitals/agent-lib/http'";
    expect(RESOLUTION_ERROR.test(logs)).toBe(true);
    expect(evaluateBoot("agent", { logs, exitCode: 1 }).ok).toBe(false);
  });

  test("fails when the agent entrypoint exits on missing env before the marker", () => {
    const r = evaluateBoot("agent", {
      logs: "[entrypoint] SHIPWRIGHT_AGENT_ID is required",
      exitCode: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exit 1");
  });

  test("fails when the marker is never logged", () => {
    expect(evaluateBoot("admin", { logs: "boom", exitCode: 1 }).ok).toBe(false);
  });
});

describe("parseArgs", () => {
  test("flags win over env; version is required", () => {
    const a = parseArgs(["--version", "1.2.3", "--dir", "/tmp/x"], {
      CONSUMER_SMOKE_VERSION: "9.9.9",
    });
    expect(a.version).toBe("1.2.3");
    expect(a.dir).toBe("/tmp/x");
    expect(parseArgs([], { CONSUMER_SMOKE_VERSION: "2.0.0" }).version).toBe(
      "2.0.0",
    );
    expect(() => parseArgs([], {})).toThrow(/version/);
  });

  test("tarball mode skips boot by default; a leading v is stripped", () => {
    const a = parseArgs(["--version", "v1.0.0", "--tarballs", "/t"], {});
    expect(a.version).toBe("1.0.0");
    expect(a.tarballs).toBe("/t");
    expect(a.boot).toBe(false);
    expect(parseArgs(["--version", "1.0.0"], {}).boot).toBe(true);
  });
});

describe("parseArgs --no-admin-boot", () => {
  test("defaults to booting admin and can be disabled", () => {
    expect(parseArgs(["--version", "1.0.0"], {}).bootAdmin).toBe(true);
    expect(
      parseArgs(["--version", "1.0.0", "--no-admin-boot"], {}).bootAdmin,
    ).toBe(false);
  });
});
