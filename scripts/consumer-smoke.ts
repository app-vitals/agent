#!/usr/bin/env bun
/**
 * scripts/consumer-smoke.ts
 *
 * Consumer smoke test: proves the published artifacts are usable WITHOUT the
 * monorepo. In an empty scratch directory it
 *
 *   1. `bun add`s @app-vitals/agent-lib, -runtime and -admin at VERSION (from
 *      the npm registry, or from local tarballs, see below),
 *      and fails if the installed tree holds more than one @app-vitals/agent-lib
 *      copy (e.g. nested under agent-admin) or any copy not at VERSION,
 *   2. derives the entry list from this repo's lib/runtime/admin package.json
 *      `exports` (non-wildcard entries as-is; wildcard patterns expanded by
 *      globbing the source dir) and imports every module entry from the
 *      installed packages. Non-module assets (json, prisma schema/migrations,
 *      package.json, prisma.config) are checked with require.resolve instead.
 *      An exports-map entry or lib module missing from the published package
 *      therefore fails the run,
 *   3. boots the published images (ghcr.io/app-vitals/agent and
 *      ghcr.io/app-vitals/agent-admin at VERSION): startAgent([]) /
 *      startAdmin([]) are what their entrypoints run. With no platform config
 *      the assertion is "starts without a module-resolution error and reaches
 *      its first log marker" (agent: agent home initialized; admin: starting
 *      admin service, then failing fast on the missing database).
 *
 * The base-image contract smoke (runtime/base-image-contract.smoke.test.ts)
 * is run by the workflow, not here.
 *
 * Usage:
 *   bun scripts/consumer-smoke.ts --version 1.2.3 [--dir SCRATCH]
 *   bun scripts/consumer-smoke.ts --version 1.2.3 --pack          # no release needed
 *   bun scripts/consumer-smoke.ts --version 1.2.3 --tarballs DIR  # prebuilt tgz
 * --no-import-probe skips step 2 (admin's entries need a generated Prisma
 * client, absent in the docker CI job). --no-admin-boot boots only the agent image (the admin image is built in a
 * separate CI job). Env: CONSUMER_SMOKE_VERSION, CONSUMER_SMOKE_DIR. Boot checks need docker and
 * are on by default for registry installs, off for --pack/--tarballs
 * (override with --boot / --no-boot).
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Exports = Record<string, string>;
export type Entry = { specifier: string; mode: "import" | "resolve" };

const PACKAGES = [
  { dir: "lib", name: "@app-vitals/agent-lib" },
  { dir: "runtime", name: "@app-vitals/agent-runtime" },
  { dir: "admin", name: "@app-vitals/agent-admin" },
] as const;

const MODULE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
/** Test files and test-support fixtures (these need dev-only deps like ajv). */
const TEST_FILE =
  /(\.(unit|integration|smoke|canary|e2e)?\.?test\.(ts|tsx|js)|\.fixtures\.ts)$/;
/** Subpaths that are code but need dev-only deps: existence check only. */
const RESOLVE_ONLY = new Set(["./prisma.config"]);

function entryMode(subpath: string, target: string): "import" | "resolve" {
  if (RESOLVE_ONLY.has(subpath)) return "resolve";
  return MODULE_FILE.test(target) ? "import" : "resolve";
}

function specifierFor(name: string, subpath: string): string {
  return subpath === "." ? name : `${name}${subpath.slice(1)}`;
}

/** Files (relative to pkgDir) a wildcard export target expands to, tests excluded. */
function expandWildcard(target: string, pkgDir: string): string[] {
  const [tgtPre, tgtPost] = target.split("*") as [string, string];
  const glob = new Bun.Glob(`${tgtPre.replace(/^\.\//, "")}**/*${tgtPost}`);
  return [...glob.scanSync({ cwd: pkgDir })]
    .filter((f) => !f.split("/").includes("node_modules"))
    .filter((f) => !TEST_FILE.test(f))
    .sort();
}

/** Expand a package.json `exports` map into probe entries. */
export function deriveEntries(
  name: string,
  exports: Exports,
  pkgDir: string,
): Entry[] {
  const out: Entry[] = [];
  for (const [subpath, target] of Object.entries(exports)) {
    if (!subpath.includes("*")) {
      out.push({
        specifier: specifierFor(name, subpath),
        mode: entryMode(subpath, target),
      });
      continue;
    }
    const [subPre, subPost] = subpath.split("*") as [string, string];
    const [tgtPre, tgtPost] = target.split("*") as [string, string];
    for (const file of expandWildcard(target, pkgDir)) {
      const star = file.slice(
        tgtPre.replace(/^\.\//, "").length,
        file.length - tgtPost.length,
      );
      const sub = `${subPre}${star}${subPost}`;
      out.push({
        specifier: specifierFor(name, sub),
        mode: entryMode(sub, target.replace("*", star)),
      });
    }
  }
  return out;
}

/** Wildcard exports that expand to zero files: they would otherwise probe nothing and pass. */
export function findEmptyWildcards(exports: Exports, pkgDir: string): string[] {
  return Object.entries(exports)
    .filter(
      ([subpath, target]) =>
        subpath.includes("*") && expandWildcard(target, pkgDir).length === 0,
    )
    .map(([subpath, target]) => `${subpath} -> ${target} matches no files`);
}

/**
 * Modules under `srcDir` (relative to pkgDir) that no exports entry reaches and
 * that are not allowlisted as private. Catches shipped-but-unexported modules.
 */
export function findUnreachableModules(
  exports: Exports,
  files: string[],
  privateModules: ReadonlySet<string> = new Set(),
): string[] {
  const targets = Object.values(exports).map((t) => t.replace(/^\.\//, ""));
  const reaches = (file: string) =>
    targets.some((t) => {
      if (!t.includes("*")) return t === file;
      const [pre, post] = t.split("*") as [string, string];
      return (
        file.length >= pre.length + post.length &&
        file.startsWith(pre) &&
        file.endsWith(post)
      );
    });
  return files
    .filter((f) => MODULE_FILE.test(f) && !TEST_FILE.test(f))
    .filter((f) => !privateModules.has(f) && !reaches(f))
    .sort()
    .map((f) => `${f} is shipped but not reachable through exports (export it or allowlist it as private)`);
}

/** Non-test modules in admin/src that are intentionally NOT exported. */
export const PRIVATE_ADMIN_MODULES: ReadonlySet<string> = new Set<string>();

/** Script run inside the scratch dir: import/resolve every entry, report all failures. */
export function buildProbeScript(entries: Entry[]): string {
  return `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const entries = ${JSON.stringify(entries)};
const failures = [];
for (const { specifier, mode } of entries) {
  try {
    if (mode === "import") await import(specifier);
    else require.resolve(specifier);
  } catch (err) {
    failures.push(specifier + " (" + mode + "): " + (err && err.message ? err.message : err));
  }
}
console.log("[consumer-smoke] checked " + entries.length + " entries, " + failures.length + " failed");
for (const f of failures) console.error("  FAIL " + f);
if (failures.length > 0) process.exit(1);
`;
}

export const RESOLUTION_ERROR =
  /Cannot find (module|package)|Module not found|ResolveMessage|Could not resolve|ERR_MODULE_NOT_FOUND/i;

const BOOT_MARKERS = {
  agent: "[agent] agent home initialized",
  admin: "[admin] starting admin service",
} as const;

export function evaluateBoot(
  kind: keyof typeof BOOT_MARKERS,
  r: { logs: string; exitCode: number | null },
): { ok: boolean; reason: string } {
  if (RESOLUTION_ERROR.test(r.logs))
    return { ok: false, reason: "module resolution error in container logs" };
  if (!r.logs.includes(BOOT_MARKERS[kind])) {
    return {
      ok: false,
      reason: `never logged "${BOOT_MARKERS[kind]}" (exit ${r.exitCode})`,
    };
  }
  return { ok: true, reason: "started past module loading" };
}

export type Args = {
  version: string;
  dir?: string;
  tarballs?: string;
  pack: boolean;
  boot: boolean;
  agentImage: string;
  adminImage: string;
  bootAdmin: boolean;
  importProbe: boolean;
};

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): Args {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = (flag("version") ?? env.CONSUMER_SMOKE_VERSION ?? "").replace(
    /^v/,
    "",
  );
  if (!version)
    throw new Error(
      "version required: --version X.Y.Z or CONSUMER_SMOKE_VERSION",
    );
  const tarballs = flag("tarballs");
  const pack = argv.includes("--pack");
  const local = pack || tarballs !== undefined;
  const boot = argv.includes("--boot")
    ? true
    : argv.includes("--no-boot")
      ? false
      : !local;
  return {
    version,
    dir: flag("dir") ?? env.CONSUMER_SMOKE_DIR,
    tarballs,
    pack,
    boot,
    agentImage: flag("agent-image") ?? `ghcr.io/app-vitals/agent:${version}`,
    importProbe: !argv.includes("--no-import-probe"),
    bootAdmin: !argv.includes("--no-admin-boot"),
    adminImage:
      flag("admin-image") ?? `ghcr.io/app-vitals/agent-admin:${version}`,
  };
}

// ─── Side-effecting steps ───────────────────────────────────────────────────

function run(cmd: string[], cwd: string, quiet = false) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  if (!quiet && p.exitCode !== 0) process.stderr.write(`${stdout}${stderr}`);
  return { exitCode: p.exitCode, stdout, stderr };
}

/** Pack lib/runtime/admin from COPIES with the version stamped; the repo is untouched. */
function packLocal(repoRoot: string, version: string, outDir: string): void {
  const work = mkdtempSync(join(tmpdir(), "consumer-smoke-pack-"));
  for (const { dir, name } of PACKAGES) {
    const dest = join(work, dir);
    cpSync(join(repoRoot, dir), dest, {
      recursive: true,
      filter: (src) => !src.split("/").includes("node_modules"),
    });
    const pkgPath = join(dest, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = version;
    for (const field of ["dependencies", "devDependencies"]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (pkg[field][dep].startsWith("workspace:")) pkg[field][dep] = version;
      }
    }
    // Drop lifecycle scripts: the copy has no node_modules to run them with.
    delete pkg.scripts;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const r = run(["bun", "pm", "pack", "--destination", outDir], dest);
    if (r.exitCode !== 0) throw new Error(`bun pm pack failed for ${name}`);
  }
}

function tarballFor(dir: string, pkgName: string): string {
  const prefix = pkgName.replace("@", "").replace("/", "-");
  const f = readdirSync(dir).find(
    (n) => n.startsWith(`${prefix}-`) && n.endsWith(".tgz"),
  );
  if (!f) throw new Error(`no tarball for ${pkgName} in ${dir}`);
  return resolve(dir, f);
}

async function install(args: Args, scratch: string): Promise<void> {
  const pkg: Record<string, unknown> = {
    name: "consumer-smoke-scratch",
    private: true,
    type: "module",
  };
  let specs: string[];
  if (args.tarballs) {
    const tgz = Object.fromEntries(
      PACKAGES.map((p) => [
        p.name,
        tarballFor(args.tarballs as string, p.name),
      ]),
    );
    // Inter-package deps (admin -> lib, runtime -> lib + admin) are pinned to
    // VERSION, which is not on the registry: point each at its local tarball.
    pkg.overrides = Object.fromEntries(
      Object.entries(tgz).map(([n, t]) => [n, `file:${t}`]),
    );
    specs = Object.values(tgz).map((t) => `file:${t}`);
  } else {
    specs = PACKAGES.map((p) => `${p.name}@${args.version}`);
  }
  writeFileSync(join(scratch, "package.json"), JSON.stringify(pkg, null, 2));
  // npm publish can lag the release: retry while the version is not yet visible.
  const attempts = args.tarballs ? 1 : 12;
  for (let i = 1; i <= attempts; i++) {
    const r = run(["bun", "add", "--no-cache", ...specs], scratch, true);
    if (r.exitCode === 0) return;
    console.error(
      `[consumer-smoke] bun add attempt ${i}/${attempts} failed: ${r.stderr.trim().split("\n").pop()}`,
    );
    if (i === attempts) throw new Error("bun add failed");
    await Bun.sleep(20_000);
  }
}

/** Paths of every installed @app-vitals/agent-lib under `scratch`, nested copies included. */
function findAgentLibCopies(scratch: string): { path: string; version: string }[] {
  const glob = new Bun.Glob("**/node_modules/@app-vitals/agent-lib/package.json");
  return [...glob.scanSync({ cwd: scratch })].sort().map((f) => ({
    path: f,
    version: JSON.parse(readFileSync(join(scratch, f), "utf8")).version,
  }));
}

/** Failures for an installed tree that is not exactly one agent-lib copy at VERSION. */
export function checkAgentLibCopies(
  copies: { path: string; version: string }[],
  version: string,
): string[] {
  const out = copies
    .filter((c) => c.version !== version)
    .map((c) => `${c.path} is ${c.version}, expected ${version}`);
  if (copies.length !== 1)
    out.push(
      `expected exactly 1 @app-vitals/agent-lib copy, found ${copies.length}: ${copies.map((c) => c.path).join(", ")}`,
    );
  return out;
}

function importProbe(repoRoot: string, scratch: string): boolean {
  let failed = false;
  const failures: string[] = [];
  const entries: Entry[] = [];
  for (const { dir, name } of PACKAGES) {
    const pkgDir = join(repoRoot, dir);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const exports = pkg.exports as Exports;
    entries.push(...deriveEntries(name, exports, pkgDir));
    for (const f of findEmptyWildcards(exports, pkgDir))
      failures.push(`${name}: ${f}`);
    if (dir === "admin") {
      const srcFiles = [...new Bun.Glob("src/**/*").scanSync({ cwd: pkgDir })];
      for (const f of findUnreachableModules(exports, srcFiles, PRIVATE_ADMIN_MODULES))
        failures.push(`${name}: ${f}`);
    }
  }
  for (const f of failures) console.error(`  FAIL exports: ${f}`);
  if (failures.length > 0) failed = true;
  writeFileSync(join(scratch, "probe.mjs"), buildProbeScript(entries));
  const r = run(["bun", "probe.mjs"], scratch, true);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.exitCode !== 0) failed = true;
  return !failed;
}

/**
 * `docker run` args for a boot check. The agent image ENTRYPOINT is
 * runtime/entrypoint-main.ts, which exits 1 on missing SHIPWRIGHT_AGENT_ID /
 * SHIPWRIGHT_API_URL / SHIPWRIGHT_AGENT_API_KEY before spawning index.ts, so
 * the agent check bypasses it and runs startAgent([]) directly. The runtime
 * image ships no workspace templates, so startAgent throws "Missing workspace
 * template" unless a specialty is supplied: the fixture specialty is mounted
 * from the checkout (what the unit/integration suites use). The admin
 * ENTRYPOINT (`bun run admin/src/main.ts`) is startAdmin([]) already. No
 * platform config is provided in either case.
 */
const FIXTURE_SPECIALTIES = resolve(
  import.meta.dir,
  "..",
  "runtime",
  "fixtures",
  "specialties",
);

export function buildDockerRunArgs(
  kind: keyof typeof BOOT_MARKERS,
  image: string,
  name: string,
  fixtureSpecialties: string,
): string[] {
  return [
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "AGENT_HOME=/tmp/agent-home",
    ...(kind === "agent"
      ? [
          "-v",
          `${fixtureSpecialties}:/fixture-specialties:ro`,
          "-e",
          "SHIPWRIGHT_SPECIALTIES_DIR=/fixture-specialties",
          "-e",
          "SHIPWRIGHT_DEFAULT_AGENT_TYPE=fixture",
        ]
      : []),
    ...(kind === "agent"
      ? ["--entrypoint", "bun", image, "run", "index.ts"]
      : [image]),
  ];
}

async function bootImage(
  kind: keyof typeof BOOT_MARKERS,
  image: string,
): Promise<boolean> {
  const name = `consumer-smoke-${kind}-${process.pid}`;
  // A locally built image (CI's agent:ci) is not on any registry: only pull when absent.
  const local = run(["docker", "image", "inspect", image], process.cwd(), true);
  if (local.exitCode !== 0) {
    const pull = run(["docker", "pull", image], process.cwd());
    if (pull.exitCode !== 0) return false;
  }
  const start = run(
    buildDockerRunArgs(kind, image, name, FIXTURE_SPECIALTIES),
    process.cwd(),
  );
  if (start.exitCode !== 0) return false;
  let logs = "";
  let exitCode: number | null = null;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const l = run(["docker", "logs", name], process.cwd(), true);
      logs = l.stdout + l.stderr;
      const st = run(
        [
          "docker",
          "inspect",
          "-f",
          "{{.State.Running}} {{.State.ExitCode}}",
          name,
        ],
        process.cwd(),
        true,
      );
      const [running, code] = st.stdout.trim().split(" ");
      if (running === "false") exitCode = Number(code);
      if (
        logs.includes(BOOT_MARKERS[kind]) ||
        RESOLUTION_ERROR.test(logs) ||
        running === "false"
      )
        break;
      await Bun.sleep(2_000);
    }
  } finally {
    run(["docker", "rm", "-f", name], process.cwd(), true);
  }
  const verdict = evaluateBoot(kind, { logs, exitCode });
  console.log(
    `[consumer-smoke] boot ${kind} ${image}: ${verdict.ok ? "ok" : "FAIL"} (${verdict.reason})`,
  );
  if (!verdict.ok) console.error(logs.split("\n").slice(-30).join("\n"));
  return verdict.ok;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const repoRoot = resolve(import.meta.dir, "..");
  const scratch = args.dir
    ? resolve(args.dir)
    : mkdtempSync(join(tmpdir(), "consumer-smoke-"));
  mkdirSync(scratch, { recursive: true });
  if (readdirSync(scratch).length > 0)
    throw new Error(`scratch dir ${scratch} is not empty`);
  console.log(`[consumer-smoke] version ${args.version}, scratch ${scratch}`);

  if (args.pack) {
    args.tarballs = mkdtempSync(join(tmpdir(), "consumer-smoke-tgz-"));
    packLocal(repoRoot, args.version, args.tarballs);
  }
  await install(args, scratch);
  const libFailures = checkAgentLibCopies(findAgentLibCopies(scratch), args.version);
  for (const f of libFailures) console.error(`  FAIL agent-lib: ${f}`);
  let ok = (args.importProbe ? importProbe(repoRoot, scratch) : true) && libFailures.length === 0;
  if (args.boot) {
    const results = [
      await bootImage("agent", args.agentImage),
      ...(args.bootAdmin ? [await bootImage("admin", args.adminImage)] : []),
    ];
    ok = ok && results.every(Boolean);
  } else {
    console.log("[consumer-smoke] boot checks skipped");
  }
  if (!ok) process.exit(1);
  console.log("[consumer-smoke] OK");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[consumer-smoke] fatal:", err);
    process.exit(1);
  });
}
