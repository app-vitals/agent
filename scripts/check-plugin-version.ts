#!/usr/bin/env bun
/**
 * scripts/check-plugin-version.ts
 *
 * Version-bump gate for the baked agent-platform plugin. Claude Code only
 * refreshes an installed plugin when its plugin.json version changes, so any
 * change under plugins/agent-platform/ must come with a plugin.json version
 * bump relative to the base ref.
 *
 * Compares tips (two-dot diff), which on a PR merge checkout is exactly the
 * PR change and needs no merge-base history.
 *
 * Usage: bun scripts/check-plugin-version.ts [baseRef]   (default origin/main)
 */

import { readFileSync } from "node:fs";

export const PLUGIN_DIR = "plugins/agent-platform/";
export const PLUGIN_JSON = `${PLUGIN_DIR}.claude-plugin/plugin.json`;

export interface PluginVersionInput {
  changedFiles: string[];
  /** plugin.json version at the base ref; undefined when the file is new. */
  baseVersion: string | undefined;
  /** plugin.json version in the working tree. */
  headVersion: string | undefined;
}

export interface PluginVersionResult {
  ok: boolean;
  message: string;
}

export function checkPluginVersion(
  input: PluginVersionInput,
): PluginVersionResult {
  const touched = input.changedFiles.filter((f) => f.startsWith(PLUGIN_DIR));
  if (touched.length === 0) {
    return { ok: true, message: "no plugin changes" };
  }
  if (!input.headVersion) {
    return { ok: false, message: `${PLUGIN_JSON} has no version field` };
  }
  if (input.baseVersion === undefined) {
    return { ok: true, message: "new plugin: initial version accepted" };
  }
  if (input.headVersion === input.baseVersion) {
    return {
      ok: false,
      message: `${touched.length} file(s) changed under ${PLUGIN_DIR} but ${PLUGIN_JSON} version is still ${input.baseVersion}; bump it`,
    };
  }
  return {
    ok: true,
    message: `plugin version bumped ${input.baseVersion} -> ${input.headVersion}`,
  };
}

function git(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() };
}

function versionOf(json: string): string | undefined {
  const v = (JSON.parse(json) as { version?: unknown }).version;
  return typeof v === "string" ? v : undefined;
}

if (import.meta.main) {
  const base = process.argv[2] ?? "origin/main";
  const diff = git(["diff", "--name-only", base, "HEAD"]);
  if (diff.code !== 0) {
    console.error(`check:plugin-version: git diff against ${base} failed`);
    process.exit(1);
  }
  const baseShow = git(["show", `${base}:${PLUGIN_JSON}`]);
  const result = checkPluginVersion({
    changedFiles: diff.out.split("\n").filter(Boolean),
    baseVersion: baseShow.code === 0 ? versionOf(baseShow.out) : undefined,
    headVersion: versionOf(readFileSync(PLUGIN_JSON, "utf8")),
  });
  console.log(`check:plugin-version: ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
