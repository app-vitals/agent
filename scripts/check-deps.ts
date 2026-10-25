#!/usr/bin/env bun
/**
 * scripts/check-deps.ts
 *
 * Declared-dependency gate. Walks the sources of each published package
 * (runtime/, lib/ and admin/src) and fails on any third-party import that the
 * owning package.json does not declare, so a consumer install resolves
 * everything the package imports:
 *
 *   - value imports in shipped sources must be in `dependencies`,
 *     `peerDependencies` or `optionalDependencies`
 *   - type-only imports may also use the package's `devDependencies`; test
 *     files and fixtures may use those or anything the workspace root declares
 *     (tests share the root toolchain)
 *   - node:/bun: builtins, bare Node builtins, `bun`, relative specifiers and
 *     the package's own name are not edges
 *
 * Usage: bun scripts/check-deps.ts [root]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";

const PACKAGES = [
  { dir: "runtime", sources: "runtime" },
  { dir: "lib", sources: "lib" },
  { dir: "admin", sources: "admin/src" },
];
const SKIP_DIRS = new Set(["node_modules", "dist", "client", "e2e"]);
/** Tests that carry import specifiers as string fixtures, not real imports. */
const FIXTURE_FILES = new Set(["import-boundary.unit.test.ts"]);
const SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/;
const TEST_FILE =
  /\.(?:unit|integration|smoke|e2e)\.test\.(?:ts|tsx)$|\.test\.(?:ts|tsx)$|\.fixtures\.ts$/;
const BUILTINS = new Set(builtinModules);

const SPECIFIER_PATTERNS = [
  /\b(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
  /\b(import)\(\s*["']([^"']+)["']\s*\)/g,
  /\b(require)\(\s*["']([^"']+)["']\s*\)/g,
  /\b(mock)\.module\(\s*["']([^"']+)["']/g,
];

export interface DepViolation {
  file: string;
  specifier: string;
  pkg: string;
  reason: string;
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Import {
  specifier: string;
  typeOnly: boolean;
}

export function extractImports(source: string): Import[] {
  const found = new Map<string, boolean>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(pattern)) {
      const typeOnly = m.length === 4 && m[2] !== undefined;
      const specifier = m[m.length - 1];
      // A specifier is type-only only if every occurrence of it is.
      found.set(specifier, (found.get(specifier) ?? true) && typeOnly);
    }
  }
  return [...found].map(([specifier, typeOnly]) => ({ specifier, typeOnly }));
}

/** The package a specifier installs from, or null when it is not an npm edge. */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:") || specifier.startsWith("bun:"))
    return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  if (name === "bun" || BUILTINS.has(name)) return null;
  return name;
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !FIXTURE_FILES.has(name)) out.push(full);
  }
}

function readManifest(path: string): Manifest {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Manifest)
    : {};
}

/** Returns every undeclared third-party import under the repository at `root`. */
export function checkDeps(root: string): DepViolation[] {
  const rootManifest = readManifest(join(root, "package.json"));
  const rootDeclared = new Set([
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.devDependencies ?? {}),
  ]);
  const violations: DepViolation[] = [];
  for (const { dir, sources } of PACKAGES) {
    const manifest = readManifest(join(root, dir, "package.json"));
    const shipped = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    const dev = new Set(Object.keys(manifest.devDependencies ?? {}));
    const files: string[] = [];
    walk(join(root, sources), files);
    for (const file of files.sort()) {
      const isTest = TEST_FILE.test(file);
      for (const { specifier, typeOnly } of extractImports(
        readFileSync(file, "utf8"),
      )) {
        const pkg = packageOf(specifier);
        if (!pkg || pkg === manifest.name || shipped.has(pkg)) continue;
        if (dev.has(pkg) && (isTest || typeOnly)) continue;
        if (isTest && rootDeclared.has(pkg)) continue;
        violations.push({
          file: relative(root, file),
          specifier,
          pkg,
          reason: `${pkg} is not in ${dir}/package.json dependencies`,
        });
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const violations = checkDeps(root);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}: "${v.specifier}" — ${v.reason}`);
    }
    console.error(`\n${violations.length} undeclared dependency import(s)`);
    process.exit(1);
  }
  console.log("declared dependencies clean");
}
