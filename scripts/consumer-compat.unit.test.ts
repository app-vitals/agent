import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstallProbe,
  buildShipwrightChecks,
  type Check,
  type CheckResult,
  type Exec,
  exitCodeFor,
  findConsumerManifests,
  parseArgs,
  renderMarkdownSummary,
  renderTable,
  rewriteConsumerManifests,
  rewriteManifestToTarballs,
  runChecks,
  SHIPWRIGHT_CHECKS,
  selectChecks,
  tailLines,
  TYPECHECK_HINT,
} from "./consumer-compat.ts";

const TARBALLS = {
  "@app-vitals/agent-lib": "/tmp/tgz/app-vitals-agent-lib-0.0.0-compat.tgz",
  "@app-vitals/agent-runtime":
    "/tmp/tgz/app-vitals-agent-runtime-0.0.0-compat.tgz",
  "@app-vitals/agent-admin": "/tmp/tgz/app-vitals-agent-admin-0.0.0-compat.tgz",
};

describe("rewriteManifestToTarballs", () => {
  const manifest = {
    name: "shipwright-admin",
    dependencies: {
      "@app-vitals/agent-admin": "0.16.2",
      "@app-vitals/agent-lib": "0.16.2",
      hono: "^4.13.1",
    },
    devDependencies: { prisma: "^7.10.0" },
  };

  test("points every consumed @app-vitals/agent-* range at its tarball", () => {
    const { manifest: out, changed } = rewriteManifestToTarballs(
      manifest,
      TARBALLS,
      false,
    );
    expect(out.dependencies).toEqual({
      "@app-vitals/agent-admin": `file:${TARBALLS["@app-vitals/agent-admin"]}`,
      "@app-vitals/agent-lib": `file:${TARBALLS["@app-vitals/agent-lib"]}`,
      hono: "^4.13.1",
    });
    expect(out.devDependencies).toEqual({ prisma: "^7.10.0" });
    expect(changed).toEqual([
      "dependencies.@app-vitals/agent-admin",
      "dependencies.@app-vitals/agent-lib",
    ]);
    // A non-root manifest gets no overrides block (bun only honors the root's).
    expect(out.overrides).toBeUndefined();
  });

  test("the root manifest also overrides all three so transitive ranges hit the tarballs", () => {
    const root = {
      name: "shipwright-monorepo",
      dependencies: { "@app-vitals/agent-lib": "0.16.2" },
      overrides: {
        uuid: "14.0.3",
        "@redocly/openapi-core": { "js-yaml": "4" },
      },
    };
    const { manifest: out } = rewriteManifestToTarballs(root, TARBALLS, true);
    expect(out.overrides).toEqual({
      uuid: "14.0.3",
      "@redocly/openapi-core": { "js-yaml": "4" },
      "@app-vitals/agent-lib": `file:${TARBALLS["@app-vitals/agent-lib"]}`,
      "@app-vitals/agent-runtime": `file:${TARBALLS["@app-vitals/agent-runtime"]}`,
      "@app-vitals/agent-admin": `file:${TARBALLS["@app-vitals/agent-admin"]}`,
    });
  });

  test("does not mutate its input", () => {
    rewriteManifestToTarballs(manifest, TARBALLS, true);
    expect(manifest.dependencies["@app-vitals/agent-lib"]).toBe("0.16.2");
    expect("overrides" in manifest).toBe(false);
  });

  test("leaves a manifest that consumes nothing unchanged", () => {
    const { changed, manifest: out } = rewriteManifestToTarballs(
      { name: "x", dependencies: { zod: "^4" } },
      TARBALLS,
      false,
    );
    expect(changed).toEqual([]);
    expect(out.dependencies).toEqual({ zod: "^4" });
  });
});

function shipwrightFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "consumer-compat-unit-"));
  const write = (rel: string, obj: unknown) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), `${JSON.stringify(obj, null, 2)}\n`);
  };
  write("package.json", {
    name: "shipwright-monorepo",
    workspaces: ["admin", "metrics", "plugins/*", "missing"],
    dependencies: { "@app-vitals/agent-lib": "0.16.2" },
  });
  write("admin/package.json", {
    name: "shipwright-admin",
    dependencies: { "@app-vitals/agent-admin": "0.16.2" },
  });
  write("metrics/package.json", { name: "metrics", dependencies: {} });
  write("plugins/shipwright/package.json", {
    name: "plugin",
    dependencies: { "@app-vitals/agent-runtime": "0.16.2" },
  });
  return dir;
}

describe("findConsumerManifests", () => {
  test("root plus every workspace manifest that exists, globs expanded", () => {
    const dir = shipwrightFixture();
    expect(findConsumerManifests(dir)).toEqual([
      "package.json",
      "admin/package.json",
      "metrics/package.json",
      "plugins/shipwright/package.json",
    ]);
  });
});

describe("rewriteConsumerManifests", () => {
  test("rewrites the consuming manifests on disk and reports each edit", () => {
    const dir = shipwrightFixture();
    const edits = rewriteConsumerManifests(dir, TARBALLS);
    expect(edits.map((e) => e.path)).toEqual([
      "package.json",
      "admin/package.json",
      "plugins/shipwright/package.json",
    ]);
    const admin = JSON.parse(
      readFileSync(join(dir, "admin/package.json"), "utf8"),
    );
    expect(admin.dependencies["@app-vitals/agent-admin"]).toBe(
      `file:${TARBALLS["@app-vitals/agent-admin"]}`,
    );
    const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(Object.keys(root.overrides)).toEqual(Object.keys(TARBALLS));
  });

  test("fails loudly when no manifest consumes the packages (wrong checkout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-compat-unit-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(() => rewriteConsumerManifests(dir, TARBALLS)).toThrow(
      /no package\.json .* depends on @app-vitals\/agent-/,
    );
  });
});

describe("SHIPWRIGHT_CHECKS / selectChecks", () => {
  test("install is the prerequisite, then the four named shipwright checks", () => {
    expect(SHIPWRIGHT_CHECKS.map((c) => c.name)).toEqual([
      "install",
      "admin-gen",
      "typecheck",
      "seed-dev-agent",
      "migration-guard",
    ]);
    expect(SHIPWRIGHT_CHECKS[0]?.prerequisite).toBe(true);
    expect(SHIPWRIGHT_CHECKS.slice(1).every((c) => !c.prerequisite)).toBe(true);
  });

  test("the check commands mirror shipwright's CI steps", () => {
    const byName = Object.fromEntries(
      SHIPWRIGHT_CHECKS.map((c) => [c.name, c]),
    );
    expect(byName.typecheck?.steps).toEqual([["bun", "run", "typecheck"]]);
    // Regenerate first (in the scratch checkout only), no drift assertion.
    expect(byName["admin-gen"]?.steps).toEqual([
      ["bun", "run", "generate:admin-spec"],
      ["bun", "run", "generate:admin-types"],
    ]);
    expect(JSON.stringify(byName["admin-gen"]?.steps)).not.toContain("diff");
    // A path, never `--filter` (not a real bun test flag).
    const seed = byName["seed-dev-agent"]?.steps.flat() ?? [];
    expect(seed).toContain("./scripts/seed-dev-agent.unit.test.ts");
    expect(seed).not.toContain("--filter");
    const guard = byName["migration-guard"];
    expect(guard?.requiredEnv).toEqual(["DATABASE_URL_SHIPWRIGHT_ADMIN"]);
    expect(guard?.steps).toContainEqual([
      "bunx",
      "prisma",
      "migrate",
      "deploy",
    ]);
  });

  test("install verifies the packed build was installed at the requested version", () => {
    const [install] = buildShipwrightChecks("9.9.9-x");
    expect(install?.steps[0]).toEqual(["bun", "install"]);
    expect(install?.steps[1]?.slice(0, 2)).toEqual(["bun", "-e"]);
    expect(install?.steps[1]?.[2]).toContain('"9.9.9-x"');
  });

  test("selecting a subset keeps the prerequisite and the declared order", () => {
    expect(
      selectChecks(SHIPWRIGHT_CHECKS, ["migration-guard", "typecheck"]).map(
        (c) => c.name,
      ),
    ).toEqual(["install", "typecheck", "migration-guard"]);
    expect(selectChecks(SHIPWRIGHT_CHECKS, undefined)).toBe(SHIPWRIGHT_CHECKS);
  });

  test("an unknown check name is an error, not a silent no-op", () => {
    expect(() => selectChecks(SHIPWRIGHT_CHECKS, ["tyepcheck"])).toThrow(
      /unknown check "tyepcheck"/,
    );
  });
});

const CHECKS: Check[] = [
  { name: "install", steps: [["bun", "install"]], prerequisite: true },
  {
    name: "admin-gen",
    steps: [
      ["bun", "run", "gen"],
      ["bun", "run", "gen2"],
    ],
  },
  { name: "typecheck", steps: [["bun", "run", "typecheck"]] },
  { name: "seed-dev-agent", steps: [["bun", "test", "./seed.ts"]] },
];

function fakeExec(failing: Record<string, string>): {
  exec: Exec;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: Exec = (argv) => {
    const cmd = argv.join(" ");
    calls.push(cmd);
    return failing[cmd] !== undefined
      ? { exitCode: 1, output: failing[cmd] }
      : { exitCode: 0, output: `ok ${cmd}\n` };
  };
  return { exec, calls };
}

describe("runChecks", () => {
  test("a failing check does not stop the later ones", () => {
    const { exec, calls } = fakeExec({
      "bun run typecheck": "admin/src/x.ts(1,10): error TS2305: no export",
    });
    const results = runChecks(CHECKS, "/sw", exec, {});
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["install", "PASS"],
      ["admin-gen", "PASS"],
      ["typecheck", "FAIL"],
      ["seed-dev-agent", "PASS"],
    ]);
    expect(calls).toContain("bun test ./seed.ts");
    expect(results[2]?.failedStep).toBe("bun run typecheck");
    expect(results[2]?.output).toContain("TS2305");
  });

  test("within a check, steps stop at the first failure", () => {
    const { exec, calls } = fakeExec({ "bun run gen": "boom" });
    const results = runChecks(CHECKS, "/sw", exec, {});
    expect(calls).not.toContain("bun run gen2");
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.failedStep).toBe("bun run gen");
  });

  test("a failed prerequisite skips everything after it", () => {
    const { exec, calls } = fakeExec({ "bun install": "resolve error" });
    const results = runChecks(CHECKS, "/sw", exec, {});
    expect(results.map((r) => r.status)).toEqual([
      "FAIL",
      "SKIP",
      "SKIP",
      "SKIP",
    ]);
    expect(calls).toEqual(["bun install"]);
  });

  test("a missing required env var fails that check with a readable reason", () => {
    const { exec, calls } = fakeExec({});
    const [result] = runChecks(
      [{ name: "migration-guard", steps: [["x"]], requiredEnv: ["DB_URL"] }],
      "/sw",
      exec,
      {},
    );
    expect(result?.status).toBe("FAIL");
    expect(result?.output).toContain("DB_URL is not set");
    expect(calls).toEqual([]);
  });

  test("steps run in the check's cwd under the shipwright dir, with its env", () => {
    const seen: { cwd: string; env: Record<string, string | undefined> }[] = [];
    runChecks(
      [{ name: "m", cwd: "admin", env: { NODE_ENV: "test" }, steps: [["x"]] }],
      "/sw",
      (_argv, opts) => {
        seen.push(opts);
        return { exitCode: 0, output: "" };
      },
      { PATH: "/bin" },
    );
    expect(seen[0]?.cwd).toBe("/sw/admin");
    expect(seen[0]?.env).toEqual({ PATH: "/bin", NODE_ENV: "test" });
  });
});

describe("missing-property hint", () => {
  const hintFor = (out: string, code = 1) => {
    const { exec } = fakeExec(code ? { "bun run typecheck": out } : {});
    return runChecks(CHECKS, "/sw", exec, {}).find(
      (r) => r.name === "typecheck",
    );
  };

  test("TS2741 adds one hint line to the failing check", () => {
    const r = hintFor(
      "admin/src/a.ts(3,7): error TS2741: Property 'x' is missing in type 'A' but required in type 'B'.",
    );
    expect(r?.status).toBe("FAIL");
    expect(r?.hint).toBe(TYPECHECK_HINT);
    expect(TYPECHECK_HINT).toContain("optional");
    expect(TYPECHECK_HINT).toContain("update the consumer");
    expect(TYPECHECK_HINT).not.toContain("\n");
  });

  test("'is missing in type' without the code also hints", () => {
    expect(hintFor("Property 'y' is missing in type '{}'")?.hint).toBe(
      TYPECHECK_HINT,
    );
  });

  test("other failures and passes get no hint", () => {
    expect(hintFor("error TS2305: no exported member")?.hint).toBeUndefined();
    expect(hintFor("", 0)?.hint).toBeUndefined();
  });

  test("the hint is rendered in the markdown summary and the table output", () => {
    const failing: CheckResult[] = [
      {
        name: "typecheck",
        status: "FAIL",
        output: "error TS2741",
        failedStep: "bun run typecheck",
        hint: TYPECHECK_HINT,
        durationMs: 1,
      },
    ];
    expect(
      renderMarkdownSummary(failing, { repo: "r", ref: "main" }),
    ).toContain(TYPECHECK_HINT);
    expect(renderTable(failing)).toContain(TYPECHECK_HINT);
  });
});

const RESULTS: CheckResult[] = [
  { name: "install", status: "PASS", output: "", durationMs: 1200 },
  {
    name: "typecheck",
    status: "FAIL",
    output: `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\nerror TS2305: Module '"@app-vitals/agent-admin"' has no exported member 'startAdmin'.`,
    failedStep: "bun run typecheck",
    durationMs: 30_000,
  },
  { name: "admin-gen", status: "PASS", output: "", durationMs: 5000 },
  { name: "seed-dev-agent", status: "SKIP", output: "", durationMs: 0 },
];

describe("summary rendering", () => {
  test("tailLines keeps the last N lines", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(tailLines("a", 5)).toBe("a");
  });

  test("markdown names the failing shipwright check and shows its output tail", () => {
    const md = renderMarkdownSummary(RESULTS, {
      repo: "app-vitals/shipwright",
      ref: "main",
      sha: "abc1234",
    });
    expect(md).toContain("app-vitals/shipwright@main");
    expect(md).toContain("abc1234");
    expect(md).toContain("| typecheck | FAIL |");
    expect(md).toContain("| install | PASS |");
    expect(md).toContain("| seed-dev-agent | SKIP |");
    expect(md).toMatch(/1 of 4 shipwright checks? failed: typecheck/);
    expect(md).toContain("`bun run typecheck`");
    expect(md).toContain("has no exported member 'startAdmin'");
    expect(md).not.toContain("line 0\n");
    expect(md.toLowerCase()).toContain("advisory");
  });

  test("an all-green run says so", () => {
    const md = renderMarkdownSummary(
      RESULTS.filter((r) => r.status === "PASS"),
      { repo: "app-vitals/shipwright", ref: "main" },
    );
    expect(md).toContain("All 2 shipwright checks passed");
    expect(md).not.toContain("<details>");
  });

  test("the stdout table lists every check with its status", () => {
    const table = renderTable(RESULTS);
    expect(table).toMatch(/typecheck\s+FAIL/);
    expect(table).toMatch(/install\s+PASS/);
    expect(table).toMatch(/seed-dev-agent\s+SKIP/);
    expect(table).toContain("bun run typecheck");
  });
});

describe("exitCodeFor", () => {
  test("non-zero when any check failed or was skipped, zero when all pass", () => {
    expect(exitCodeFor(RESULTS)).toBe(1);
    expect(exitCodeFor(RESULTS.filter((r) => r.status !== "FAIL"))).toBe(1);
    expect(exitCodeFor(RESULTS.filter((r) => r.status === "PASS"))).toBe(0);
    expect(exitCodeFor([])).toBe(1);
  });
});

describe("buildInstallProbe", () => {
  const NAMES = ["@app-vitals/agent-lib", "@app-vitals/agent-admin"];
  function installed(pkgs: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "consumer-compat-probe-"));
    for (const [path, version] of Object.entries(pkgs)) {
      mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(
        join(dir, path, "package.json"),
        JSON.stringify({ name: path.split("node_modules/").pop(), version }),
      );
    }
    return dir;
  }
  const probe = (cwd: string) =>
    Bun.spawnSync(["bun", "-e", buildInstallProbe("0.0.0-compat", NAMES)], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

  test("passes when every copy is the packed version", () => {
    const dir = installed({
      "node_modules/@app-vitals/agent-lib": "0.0.0-compat",
      "node_modules/@app-vitals/agent-admin": "0.0.0-compat",
      "admin/node_modules/@app-vitals/agent-lib": "0.0.0-compat",
    });
    expect(probe(dir).exitCode).toBe(0);
  });

  test("follows the symlinks bun leaves in node_modules", () => {
    const dir = installed({
      "node_modules/.bun/store/node_modules/@app-vitals/agent-lib":
        "0.0.0-compat",
      "node_modules/.bun/store/node_modules/@app-vitals/agent-admin":
        "0.0.0-compat",
    });
    mkdirSync(join(dir, "node_modules/@app-vitals"), { recursive: true });
    for (const n of ["agent-lib", "agent-admin"]) {
      symlinkSync(
        join(dir, "node_modules/.bun/store/node_modules/@app-vitals", n),
        join(dir, "node_modules/@app-vitals", n),
      );
    }
    expect(probe(dir).exitCode).toBe(0);
  });

  test("fails on a registry copy left behind or a missing package", () => {
    const stale = installed({
      "node_modules/@app-vitals/agent-lib": "0.0.0-compat",
      "node_modules/@app-vitals/agent-admin": "0.0.0-compat",
      "metrics/node_modules/@app-vitals/agent-lib": "0.16.2",
    });
    const r = probe(stale);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("is 0.16.2");
    const missing = installed({
      "node_modules/@app-vitals/agent-lib": "0.0.0-compat",
    });
    expect(probe(missing).stderr.toString()).toContain(
      "@app-vitals/agent-admin is not installed",
    );
  });
});

describe("parseArgs", () => {
  test("requires the shipwright checkout dir", () => {
    expect(() => parseArgs([], {})).toThrow(/--shipwright-dir/);
  });

  test("defaults: compat version, all checks, summary from GITHUB_STEP_SUMMARY", () => {
    const a = parseArgs(["--shipwright-dir", "sw"], {
      GITHUB_STEP_SUMMARY: "/tmp/summary.md",
    });
    expect(a.shipwrightDir).toMatch(/\/sw$/);
    expect(a.version).toBe("0.0.0-compat");
    expect(a.checks).toBeUndefined();
    expect(a.summaryPath).toBe("/tmp/summary.md");
    expect(a.repo).toBe("app-vitals/shipwright");
    expect(a.ref).toBe("main");
    expect(a.tarballs).toBeUndefined();
  });

  test("flags and env override the defaults", () => {
    const a = parseArgs(
      [
        "--shipwright-dir",
        "/abs/sw",
        "--checks",
        "typecheck, migration-guard",
        "--tarballs",
        "/tgz",
        "--version",
        "v1.2.3",
      ],
      { SHIPWRIGHT_REPO: "me/shipwright", SHIPWRIGHT_REF: "feat" },
    );
    expect(a.shipwrightDir).toBe("/abs/sw");
    expect(a.checks).toEqual(["typecheck", "migration-guard"]);
    expect(a.tarballs).toBe("/tgz");
    expect(a.version).toBe("1.2.3");
    expect(a.repo).toBe("me/shipwright");
    expect(a.ref).toBe("feat");
  });
});
