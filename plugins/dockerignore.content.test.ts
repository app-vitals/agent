/**
 * plugins/dockerignore.content.test.ts
 *
 * Guards the baked `plugins/` tree against `.dockerignore` exclusion: the
 * runtime image COPYs plugins/, so a tracked file silently dropped by a
 * `.dockerignore` rule would ship a broken plugin install (no docker needed).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

interface Rule {
  negate: boolean;
  glob: Bun.Glob;
}

/** Parse `.dockerignore` into rules (comments/blank lines dropped). */
export function parseDockerignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1).trim();
    line = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (line) rules.push({ negate, glob: new Bun.Glob(line) });
  }
  return rules;
}

/**
 * Docker semantics: a rule matches a path or any of its parent directories;
 * the last matching rule wins, and `!` rules re-include.
 */
export function isExcluded(path: string, rules: Rule[]): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((c) => rule.glob.match(c))) excluded = !rule.negate;
  }
  return excluded;
}

function trackedPluginFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "plugins"], {
    cwd: REPO_ROOT,
  });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString().split("\n").filter(Boolean);
}

const rules = parseDockerignore(
  readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8"),
);

describe("dockerignore matcher", () => {
  const sample = parseDockerignore("**/coverage\nnode_modules\n!keep/coverage");
  test("excludes nested and parent-directory matches", () => {
    expect(isExcluded("plugins/x/coverage/a.json", sample)).toBe(true);
    expect(isExcluded("node_modules/a/b.js", sample)).toBe(true);
  });
  test("honours negation and leaves other paths alone", () => {
    expect(isExcluded("keep/coverage/a.json", sample)).toBe(false);
    expect(isExcluded("plugins/x/SKILL.md", sample)).toBe(false);
  });
});

describe("baked plugins/ vs .dockerignore", () => {
  test("no tracked file under plugins/ is excluded", () => {
    const files = trackedPluginFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => isExcluded(f, rules))).toEqual([]);
  });
});
