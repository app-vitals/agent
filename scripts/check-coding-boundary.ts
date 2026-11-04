#!/usr/bin/env bun
/**
 * scripts/check-coding-boundary.ts
 *
 * Coding-vs-platform boundary gate. Platform modules (runtime/, admin/, lib/,
 * chat/) must not reference coding-owned modules or concepts outside the
 * extension seam. Today's known leaks are recorded in
 * scripts/coding-boundary-allowlist.txt; the gate fails on
 *
 *   - any NEW leak (a rule/file pair, or a higher count, not in the allowlist)
 *   - any STALE allowlist entry (the leak was removed or reduced)
 *
 * so the allowlist can only shrink. Rules:
 *
 *   coding-module   an import of a coding-owned module
 *                   (coding-task-store-provisioning-client, task-store-types,
 *                   claim-ttl, default-account), or the module file itself
 *   coding-literal  a "coding" string literal (comments are ignored)
 *   default-plugins the DEFAULT_PLUGINS shipwright default
 *
 * Test files, fixtures and e2e are not scanned.
 *
 * Permanent, deliberate exception (not allowlisted, not scanned): the
 * coding.prisma schema file and the CODING-OWNED Agent columns in
 * schema.prisma stay in the platform database schema on purpose (see PCD-6.1).
 * This gate only reads TypeScript sources, so they never count as leaks.
 *
 * Allowlist line format: `<rule> <file> <count>`; `#` starts a comment.
 *
 * Usage: bun scripts/check-coding-boundary.ts [root]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { extractSpecifiers, walk } from "./check-import-boundary.ts";

const PLATFORM_DIRS = ["runtime", "admin", "lib", "chat"];
const NON_PRODUCTION = /\.(?:unit|integration|smoke|e2e)\.test\.|\.fixtures\./;
const CODING_MODULES = [
  "coding-task-store-provisioning-client",
  "task-store-types",
  "claim-ttl",
  "default-account",
];
const ALLOWLIST_PATH = join("scripts", "coding-boundary-allowlist.txt");

export interface CodingLeak {
  rule: string;
  file: string;
  count: number;
}

export interface CodingBoundaryResult {
  newLeaks: CodingLeak[];
  staleEntries: CodingLeak[];
}

/** Drops block comments and whole-line/trailing `//` comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function moduleName(spec: string): string | undefined {
  const base = spec.split("/").pop()?.replace(/\.(?:ts|js)$/, "");
  return CODING_MODULES.find((m) => m === base);
}

/** Counts every coding reference in the platform dirs, keyed by rule + file. */
export function scanCodingLeaks(root: string): CodingLeak[] {
  const files: string[] = [];
  for (const dir of PLATFORM_DIRS) walk(join(root, dir), files);
  const leaks: CodingLeak[] = [];
  for (const full of files.sort()) {
    if (NON_PRODUCTION.test(full)) continue;
    const file = relative(root, full).split(sep).join("/");
    const raw = readFileSync(full, "utf8");
    const code = stripComments(raw);
    const counts: Record<string, number> = {
      "coding-module": extractSpecifiers(code).filter(moduleName).length,
      "coding-literal": code.match(/(["'`])coding\1/g)?.length ?? 0,
      "default-plugins": code.match(/\bDEFAULT_PLUGINS\b/g)?.length ?? 0,
    };
    if (moduleName(file)) counts["coding-module"] += 1;
    for (const [rule, count] of Object.entries(counts)) {
      if (count > 0) leaks.push({ rule, file, count });
    }
  }
  return leaks;
}

export function parseAllowlist(text: string): CodingLeak[] {
  const entries: CodingLeak[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const [rule, file, count] = trimmed.split(/\s+/);
    if (!rule || !file || !/^\d+$/.test(count ?? "")) {
      throw new Error(`malformed allowlist line: "${line}"`);
    }
    entries.push({ rule, file, count: Number(count) });
  }
  return entries;
}

export function formatAllowlist(leaks: CodingLeak[]): string {
  return leaks.map((l) => `${l.rule} ${l.file} ${l.count}`).join("\n");
}

/** Diffs the repository's leaks against the allowlist. */
export function checkCodingBoundary(
  root: string,
  allowlist: CodingLeak[],
): CodingBoundaryResult {
  const key = (l: CodingLeak) => `${l.rule} ${l.file}`;
  const allowed = new Map(allowlist.map((l) => [key(l), l.count]));
  const actual = scanCodingLeaks(root);
  const actualByKey = new Map(actual.map((l) => [key(l), l.count]));
  const newLeaks = actual.filter((l) => l.count > (allowed.get(key(l)) ?? 0));
  const staleEntries = allowlist.filter(
    (l) => (actualByKey.get(key(l)) ?? 0) < l.count,
  );
  return { newLeaks, staleEntries };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  if (args.includes("--print")) {
    console.log(formatAllowlist(scanCodingLeaks(root)));
    process.exit(0);
  }
  const path = join(root, ALLOWLIST_PATH);
  const allowlist = existsSync(path)
    ? parseAllowlist(readFileSync(path, "utf8"))
    : [];
  const { newLeaks, staleEntries } = checkCodingBoundary(root, allowlist);
  for (const l of newLeaks) {
    console.error(
      `NEW coding leak: ${l.file} [${l.rule}] x${l.count} — platform code may not reference coding-owned modules or concepts`,
    );
  }
  for (const l of staleEntries) {
    console.error(
      `STALE allowlist entry: ${l.file} [${l.rule}] x${l.count} no longer matches — shrink ${ALLOWLIST_PATH}`,
    );
  }
  if (newLeaks.length + staleEntries.length > 0) {
    console.error(
      `\n${newLeaks.length} new leak(s), ${staleEntries.length} stale entr(y/ies)`,
    );
    process.exit(1);
  }
  console.log("coding boundary clean");
}
