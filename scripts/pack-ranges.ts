#!/usr/bin/env bun
/**
 * scripts/pack-ranges.ts
 *
 * `bun pm pack` does not pick up the version stamped by the release workflow
 * when it rewrites workspace:* ranges, so published packages used to depend on
 * the previous @app-vitals/agent-lib. Two commands keep every inter-package
 * range pinned to the release VERSION:
 *
 *   bun scripts/pack-ranges.ts rewrite --version X.Y.Z DIR...
 *       rewrite every @app-vitals/* dependency range in DIR/package.json to X.Y.Z
 *   bun scripts/pack-ranges.ts assert --version X.Y.Z TARBALL...
 *       fail when any packed manifest carries a different @app-vitals/* range
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type Manifest = Partial<
  Record<(typeof DEP_FIELDS)[number], Record<string, string>>
> &
  Record<string, unknown>;

const isInternal = (dep: string) => dep.startsWith("@app-vitals/");

/** Return a copy of `manifest` with every @app-vitals/* range set to `version`. */
export function rewriteRanges<T extends Manifest>(
  manifest: T,
  version: string,
): T {
  const out: Manifest = { ...manifest };
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    out[field] = Object.fromEntries(
      Object.entries(deps).map(([dep, range]) => [
        dep,
        isInternal(dep) ? version : range,
      ]),
    );
  }
  return out as T;
}

/** List every @app-vitals/* range in `manifest` that is not exactly `version`. */
export function findMismatchedRanges(
  manifest: Manifest,
  version: string,
): string[] {
  const bad: string[] = [];
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (isInternal(dep) && range !== version)
        bad.push(`${field}.${dep}: ${range} (expected ${version})`);
    }
  }
  return bad;
}

function readTarballManifest(tarball: string): Manifest {
  const p = Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"]);
  if (p.exitCode !== 0)
    throw new Error(`cannot read package.json from ${tarball}: ${p.stderr}`);
  return JSON.parse(p.stdout.toString());
}

export function parseCli(argv: string[]): {
  command: string;
  version: string;
  targets: string[];
} {
  const [command = "", ...rest] = argv;
  const i = rest.indexOf("--version");
  const version = i >= 0 ? (rest[i + 1] ?? "") : "";
  if (!["rewrite", "assert"].includes(command) || !version)
    throw new Error(
      "usage: pack-ranges.ts <rewrite DIR...|assert TARBALL...> --version X.Y.Z",
    );
  const targets = rest.filter((_, j) => j !== i && j !== i + 1);
  if (targets.length === 0) throw new Error("no targets given");
  return { command, version, targets };
}

function main(): void {
  const { command, version, targets } = parseCli(process.argv.slice(2));
  if (command === "rewrite") {
    for (const dir of targets) {
      const path = join(dir, "package.json");
      const next = rewriteRanges(
        JSON.parse(readFileSync(path, "utf8")),
        version,
      );
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`[pack-ranges] ${path}: @app-vitals/* ranges -> ${version}`);
    }
    return;
  }
  let failed = false;
  for (const tarball of targets) {
    const bad = findMismatchedRanges(readTarballManifest(tarball), version);
    for (const b of bad) console.error(`[pack-ranges] ${tarball}: ${b}`);
    if (bad.length > 0) failed = true;
    else console.log(`[pack-ranges] ${tarball}: ok`);
  }
  if (failed) process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(
      "[pack-ranges] fatal:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}
