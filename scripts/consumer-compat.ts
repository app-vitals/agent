#!/usr/bin/env bun
/**
 * scripts/consumer-compat.ts
 *
 * Consumer-compat check against shipwright (the downstream consumer of the
 * three published packages). A change here that breaks shipwright used to be
 * found only after publish, when shipwright's platform-bump PR went red. This
 * script finds it on the agent PR instead:
 *
 *   1. packs @app-vitals/agent-lib, -runtime and -admin from this checkout
 *      (consumer-smoke's packLocal, version stamped to VERSION),
 *   2. rewrites every shipwright package.json that depends on them (root and
 *      each workspace) to `file:` the tarballs, plus root `overrides` so the
 *      packages' own inter-package ranges resolve to the tarballs too,
 *   3. `bun install`s the shipwright checkout and verifies every installed
 *      @app-vitals/agent-* copy is the packed build,
 *   4. runs shipwright's fast checks (SHIPWRIGHT_CHECKS) one after another;
 *      each is independent, so one failure does not hide the next,
 *   5. writes a markdown summary ($GITHUB_STEP_SUMMARY) and a stdout table
 *      naming each check PASS/FAIL/SKIP with the tail of failing output, and
 *      exits 1 when any check did not pass.
 *
 * Deliberately not the full shipwright suite: the checks are the ones that
 * catch a removed/renamed export or a broken schema/migration cheaply.
 *
 * Usage:
 *   bun scripts/consumer-compat.ts --shipwright-dir PATH
 *     [--version 0.0.0-compat] [--tarballs DIR] [--checks a,b] [--summary FILE]
 *     [--repo app-vitals/shipwright] [--ref main]
 * --tarballs skips packing and uses prebuilt tgz. --checks runs a subset (the
 * install prerequisite always runs). --repo/--ref only label the summary.
 * Env: SHIPWRIGHT_DIR, SHIPWRIGHT_REPO, SHIPWRIGHT_REF, GITHUB_STEP_SUMMARY.
 * The migration-guard check needs DATABASE_URL_SHIPWRIGHT_ADMIN (a throwaway
 * Postgres; the workflow provides one as a service container).
 *
 * The admin-gen check regenerates shipwright's admin spec and types from the
 * packed agent-admin BEFORE typecheck, so typecheck sees this PR's admin
 * surface (a removed response field breaks the line that reads it). There is
 * no drift assertion: a stale committed spec in shipwright is expected when
 * this PR changes the admin surface. A missing-property typecheck error gets
 * a one-line hint (make the member optional, or update the consumer first).
 *
 * Read-only toward shipwright: this script edits only the throwaway checkout
 * (package.json, bun.lock, node_modules, regenerated admin files) and never
 * pushes, opens PRs or uses credentials. Point it at a scratch checkout,
 * never a working copy.
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGES, packLocal, tarballFor } from "./consumer-smoke.ts";

export const DEFAULT_VERSION = "0.0.0-compat";
export const DEFAULT_REPO = "app-vitals/shipwright";
export const DEFAULT_REF = "main";
const TAIL_LINES = 40;
const MAX_LINE = 400;

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type Manifest = Record<string, unknown> &
  Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>> & {
    overrides?: Record<string, unknown>;
  };

/** Package name -> absolute tarball path. */
export type Tarballs = Record<string, string>;

// ─── Manifest rewrite ───────────────────────────────────────────────────────

/**
 * Return a copy of `manifest` with every dependency on a packed package
 * pointed at its tarball. The root manifest also gets an `overrides` entry for
 * every tarball (bun honors only the root's), so the packages' own pinned
 * inter-package ranges resolve to the tarballs instead of the registry.
 */
export function rewriteManifestToTarballs(
  manifest: Manifest,
  tarballs: Tarballs,
  isRoot: boolean,
): { manifest: Manifest; changed: string[] } {
  const out: Manifest = { ...manifest };
  const changed: string[] = [];
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    out[field] = Object.fromEntries(
      Object.entries(deps).map(([dep, range]) => {
        const tgz = tarballs[dep];
        if (tgz === undefined) return [dep, range];
        changed.push(`${field}.${dep}`);
        return [dep, `file:${tgz}`];
      }),
    );
  }
  if (isRoot) {
    out.overrides = {
      ...(manifest.overrides ?? {}),
      ...Object.fromEntries(
        Object.entries(tarballs).map(([n, t]) => [n, `file:${t}`]),
      ),
    };
  }
  return { manifest: out, changed };
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Root package.json plus every existing workspace manifest (globs expanded), relative to `dir`. */
export function findConsumerManifests(dir: string): string[] {
  const root = readJson(join(dir, "package.json"));
  const ws = root.workspaces as string[] | { packages?: string[] } | undefined;
  const patterns = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  const out = ["package.json"];
  for (const p of patterns) {
    const found = /[*?{[]/.test(p)
      ? [
          ...new Bun.Glob(`${p}/package.json`).scanSync({
            cwd: dir,
            onlyFiles: true,
          }),
        ]
          .filter((f) => !f.split("/").includes("node_modules"))
          .sort()
      : existsSync(join(dir, p, "package.json"))
        ? [`${p}/package.json`]
        : [];
    for (const f of found) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** Rewrite the consuming manifests under `dir` in place; returns what changed. */
export function rewriteConsumerManifests(
  dir: string,
  tarballs: Tarballs,
): { path: string; changed: string[] }[] {
  const planned = findConsumerManifests(dir).map((path) => {
    const r = rewriteManifestToTarballs(
      readJson(join(dir, path)),
      tarballs,
      path === "package.json",
    );
    return { path, ...r };
  });
  if (planned.every((p) => p.changed.length === 0))
    throw new Error(
      `no package.json under ${dir} depends on @app-vitals/agent-*; is this a shipwright checkout?`,
    );
  const edits: { path: string; changed: string[] }[] = [];
  for (const p of planned) {
    if (p.changed.length === 0 && p.path !== "package.json") continue;
    writeFileSync(
      join(dir, p.path),
      `${JSON.stringify(p.manifest, null, 2)}\n`,
    );
    edits.push({ path: p.path, changed: p.changed });
  }
  return edits;
}

// ─── Check list ─────────────────────────────────────────────────────────────

export type Check = {
  name: string;
  /** Relative to the shipwright checkout. */
  cwd?: string;
  /** Commands (argv) run in order; the check fails at the first non-zero exit. */
  steps: string[][];
  env?: Record<string, string>;
  /** Env vars the check cannot run without; missing ones fail it with a reason. */
  requiredEnv?: string[];
  /** A failed prerequisite skips every later check. */
  prerequisite?: boolean;
};

/**
 * Script run in the shipwright checkout after install: every installed
 * @app-vitals/agent-* copy must be the packed build, otherwise the checks
 * would silently run against the registry release.
 */
export function buildInstallProbe(
  version: string,
  names: readonly string[],
): string {
  return `const want = ${JSON.stringify(version)};
const names = ${JSON.stringify(names)};
const found = [];
// bun links installed packages (symlinks into node_modules/.bun), so the scan
// must follow symlinks; the root and one level of workspaces is every place a
// package can land, which avoids walking the whole node_modules tree.
const globs = ["node_modules/@app-vitals/*/package.json", "*/node_modules/@app-vitals/*/package.json"];
for (const f of globs.flatMap((g) => [...new Bun.Glob(g).scanSync({ onlyFiles: true, followSymlinks: true })])) {
  const pkg = JSON.parse(await Bun.file(f).text());
  if (names.includes(pkg.name)) found.push({ f, name: pkg.name, version: pkg.version });
}
const bad = found.filter((c) => c.version !== want);
const missing = names.filter((n) => !found.some((c) => c.name === n));
for (const c of found) console.log("  " + c.f + " " + c.version);
for (const c of bad) console.error("  FAIL " + c.f + " is " + c.version + ", expected the packed " + want);
for (const n of missing) console.error("  FAIL " + n + " is not installed");
if (bad.length > 0 || missing.length > 0) process.exit(1);
console.log("[consumer-compat] every @app-vitals/agent-* copy is the packed " + want);
`;
}

/** Shipwright's fast checks, mirroring the matching steps of its ci.yml. */
export function buildShipwrightChecks(version: string): Check[] {
  return [
    {
      name: "install",
      prerequisite: true,
      steps: [
        ["bun", "install"],
        [
          "bun",
          "-e",
          buildInstallProbe(
            version,
            PACKAGES.map((p) => p.name),
          ),
        ],
      ],
    },
    {
      // Regenerate the admin spec/types from the packed agent-admin FIRST, in
      // the scratch checkout only (nothing is committed or pushed), so the
      // typecheck below sees this PR's admin surface. No drift assertion: it
      // deadlocked PRs that change the admin surface.
      name: "admin-gen",
      steps: [
        ["bun", "run", "generate:admin-spec"],
        ["bun", "run", "generate:admin-types"],
      ],
    },
    { name: "typecheck", steps: [["bun", "run", "typecheck"]] },
    {
      name: "seed-dev-agent",
      env: { NODE_ENV: "test" },
      steps: [["bun", "test", "./scripts/seed-dev-agent.unit.test.ts"]],
    },
    {
      // The admin schema and migration history ship in @app-vitals/agent-admin:
      // shipwright's guard pins the pre-swap history and its additive-only
      // rule, then the PR's migrations must apply to an empty database.
      name: "migration-guard",
      cwd: "admin",
      env: { NODE_ENV: "test" },
      requiredEnv: ["DATABASE_URL_SHIPWRIGHT_ADMIN"],
      steps: [
        ["bun", "test", "./src/platform-migrations.unit.test.ts"],
        ["bunx", "prisma", "migrate", "deploy"],
      ],
    },
  ];
}

export const SHIPWRIGHT_CHECKS: Check[] =
  buildShipwrightChecks(DEFAULT_VERSION);

/** The named subset (prerequisites always kept), in declared order. */
export function selectChecks(
  checks: Check[],
  names: string[] | undefined,
): Check[] {
  if (names === undefined) return checks;
  for (const n of names)
    if (!checks.some((c) => c.name === n))
      throw new Error(
        `unknown check "${n}"; known: ${checks.map((c) => c.name).join(", ")}`,
      );
  return checks.filter((c) => c.prerequisite || names.includes(c.name));
}

// ─── Running ────────────────────────────────────────────────────────────────

export type Env = Record<string, string | undefined>;
export type Exec = (
  argv: string[],
  opts: { cwd: string; env: Env },
) => { exitCode: number | null; output: string };

export type CheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  output: string;
  failedStep?: string;
  durationMs: number;
  /** One-line remediation hint appended to the failing check's summary. */
  hint?: string;
};

export const TYPECHECK_HINT =
  "Hint: a required member was added that shipwright does not provide; make the new member optional, or update the consumer (shipwright) first.";

/** TS2741 / "is missing in type": a new required member breaks the consumer. */
export function hintForOutput(name: string, output: string): string | undefined {
  return name === "typecheck" &&
    (/\bTS2741\b/.test(output) || output.includes("is missing in type"))
    ? TYPECHECK_HINT
    : undefined;
}

/** Readable one-line form of a step (inline scripts are elided). */
export function stepLabel(argv: string[]): string {
  return argv.map((a) => (a.includes("\n") ? "<inline script>" : a)).join(" ");
}

export function runChecks(
  checks: Check[],
  shipwrightDir: string,
  exec: Exec,
  baseEnv: Env,
): CheckResult[] {
  const results: CheckResult[] = [];
  let blockedBy: string | null = null;
  for (const check of checks) {
    if (blockedBy !== null) {
      results.push({
        name: check.name,
        status: "SKIP",
        output: `skipped: prerequisite "${blockedBy}" failed`,
        durationMs: 0,
      });
      continue;
    }
    const env: Env = { ...baseEnv, ...check.env };
    const cwd = check.cwd ? join(shipwrightDir, check.cwd) : shipwrightDir;
    const started = Date.now();
    const missing = (check.requiredEnv ?? []).filter((k) => !env[k]);
    let result: CheckResult;
    if (missing.length > 0) {
      result = {
        name: check.name,
        status: "FAIL",
        output: missing
          .map((k) => `${k} is not set; the ${check.name} check needs it`)
          .join("\n"),
        failedStep: "environment",
        durationMs: 0,
      };
    } else {
      let output = "";
      let failedStep: string | undefined;
      for (const argv of check.steps) {
        const r = exec(argv, { cwd, env });
        output += `$ ${stepLabel(argv)}\n${r.output}`;
        if (r.exitCode !== 0) {
          failedStep = stepLabel(argv);
          output += `\n(exit ${r.exitCode})\n`;
          break;
        }
      }
      result = {
        name: check.name,
        status: failedStep === undefined ? "PASS" : "FAIL",
        output,
        failedStep,
        durationMs: Date.now() - started,
        ...(failedStep !== undefined && hintForOutput(check.name, output)
          ? { hint: hintForOutput(check.name, output) }
          : {}),
      };
    }
    results.push(result);
    if (result.status === "FAIL" && check.prerequisite) blockedBy = check.name;
  }
  return results;
}

/** Non-zero unless every check ran and passed. */
export function exitCodeFor(results: CheckResult[]): 0 | 1 {
  return results.length > 0 && results.every((r) => r.status === "PASS")
    ? 0
    : 1;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

export function tailLines(output: string, n: number): string {
  return output.trimEnd().split("\n").slice(-n).join("\n");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function headline(results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  if (failed.length === 0 && skipped.length === 0)
    return `All ${results.length} shipwright checks passed.`;
  const parts = [
    `${failed.length} of ${results.length} shipwright checks failed: ${failed.map((r) => r.name).join(", ")}`,
  ];
  if (skipped.length > 0)
    parts.push(
      `${skipped.length} skipped: ${skipped.map((r) => r.name).join(", ")}`,
    );
  return `${parts.join("; ")}.`;
}

export function renderMarkdownSummary(
  results: CheckResult[],
  ctx: { repo: string; ref: string; sha?: string },
): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const target = `${ctx.repo}@${ctx.ref}${ctx.sha ? ` (\`${ctx.sha}\`)` : ""}`;
  const lines = [
    "## Consumer compat: shipwright",
    "",
    `Advisory check (not required): this PR's @app-vitals/agent-lib, -runtime and -admin, packed and installed into ${target}, then shipwright's fast checks.`,
    "",
    `**${headline(results)}**`,
    "",
    "| Check | Status | Failed step | Time |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${cell(r.name)} | ${r.status} | ${r.failedStep ? `\`${cell(r.failedStep)}\`` : ""} | ${seconds(r.durationMs)} |`,
    ),
  ];
  for (const r of results.filter((x) => x.status === "FAIL")) {
    const tail = tailLines(r.output, TAIL_LINES)
      .split("\n")
      .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}...` : l))
      .join("\n");
    lines.push(
      "",
      `<details open><summary><b>${r.name}</b> failed at <code>${r.failedStep ?? ""}</code> (last ${TAIL_LINES} lines)</summary>`,
      "",
      "~~~text",
      tail.replace(/^~~~/gm, "\\~~~"),
      "~~~",
      ...(r.hint ? ["", r.hint] : []),
      "",
      "</details>",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderTable(results: CheckResult[]): string {
  const rows = [
    ["CHECK", "STATUS", "TIME", "FAILED STEP"],
    ...results.map((r) => [
      r.name,
      r.status,
      seconds(r.durationMs),
      r.failedStep ?? "",
    ]),
  ];
  const widths = [0, 1, 2].map((i) =>
    Math.max(...rows.map((row) => (row[i] ?? "").length)),
  );
  const table = rows
    .map((row) =>
      row
        .map((c, i) => (i < 3 ? c.padEnd(widths[i] ?? 0) : c))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  const hints = results.flatMap((r) => (r.hint ? [`${r.name}: ${r.hint}`] : []));
  return hints.length > 0 ? `${table}\n\n${hints.join("\n")}` : table;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export type Args = {
  shipwrightDir: string;
  version: string;
  tarballs?: string;
  checks?: string[];
  summaryPath?: string;
  repo: string;
  ref: string;
};

export function parseArgs(argv: string[], env: Env): Args {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = flag("shipwright-dir") ?? env.SHIPWRIGHT_DIR;
  if (!dir)
    throw new Error(
      "shipwright checkout required: --shipwright-dir PATH or SHIPWRIGHT_DIR",
    );
  const checks = flag("checks")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    shipwrightDir: resolve(dir),
    version: (flag("version") ?? DEFAULT_VERSION).replace(/^v/, ""),
    tarballs: flag("tarballs"),
    checks,
    summaryPath: flag("summary") ?? env.GITHUB_STEP_SUMMARY,
    repo: flag("repo") ?? env.SHIPWRIGHT_REPO ?? DEFAULT_REPO,
    ref: flag("ref") ?? env.SHIPWRIGHT_REF ?? DEFAULT_REF,
  };
}

const realExec: Exec = (argv, { cwd, env }) => {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  console.log(`::group::[consumer-compat] ${stepLabel(argv)}`);
  const p = Bun.spawnSync(argv, {
    cwd,
    env: clean,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${p.stdout.toString()}${p.stderr.toString()}`;
  process.stdout.write(output);
  console.log("::endgroup::");
  return { exitCode: p.exitCode, output };
};

function main(): void {
  const args = parseArgs(process.argv.slice(2), process.env);
  const checks = selectChecks(buildShipwrightChecks(args.version), args.checks);
  const repoRoot = resolve(import.meta.dir, "..");
  const tgzDir =
    args.tarballs ?? mkdtempSync(join(tmpdir(), "consumer-compat-tgz-"));
  if (!args.tarballs) {
    console.log(`[consumer-compat] packing ${args.version} into ${tgzDir}`);
    packLocal(repoRoot, args.version, tgzDir);
  }
  const tarballs: Tarballs = Object.fromEntries(
    PACKAGES.map((p) => [p.name, tarballFor(tgzDir, p.name)]),
  );
  for (const e of rewriteConsumerManifests(args.shipwrightDir, tarballs))
    console.log(
      `[consumer-compat] ${e.path}: ${e.changed.length > 0 ? e.changed.join(", ") : "overrides only"} -> tarballs`,
    );
  const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: args.shipwrightDir,
  })
    .stdout.toString()
    .trim();

  const results = runChecks(checks, args.shipwrightDir, realExec, process.env);
  const md = renderMarkdownSummary(results, {
    repo: args.repo,
    ref: args.ref,
    sha: sha || undefined,
  });
  if (args.summaryPath) appendFileSync(args.summaryPath, md);
  console.log(`\n[consumer-compat] ${headline(results)}`);
  console.log(renderTable(results));
  for (const r of results.filter((x) => x.status === "FAIL")) {
    console.error(`\n--- ${r.name} failed at: ${r.failedStep} ---`);
    console.error(tailLines(r.output, TAIL_LINES));
  }
  process.exit(exitCodeFor(results));
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[consumer-compat] fatal:", msg);
    // Pack/rewrite failures happen before any check: still say so on the PR.
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Consumer compat: shipwright\n\n**Could not run the shipwright checks:** ${msg}\n`,
      );
    process.exit(1);
  }
}
