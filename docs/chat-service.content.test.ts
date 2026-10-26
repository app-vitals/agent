/**
 * docs/chat-service.content.test.ts
 *
 * Content-layer tests for docs/chat-service.md: the guide must name every
 * env var the chat service reads and point at the committed OpenAPI document.
 * Pure file reads, no I/O boundary beyond the repo checkout.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectTsFiles,
  extractEnvVarNames,
} from "../scripts/check-config-docs.ts";

const DOCS_DIR = import.meta.dir;
const REPO_ROOT = join(DOCS_DIR, "..");

const guide = readFileSync(join(DOCS_DIR, "chat-service.md"), "utf-8");

/** Every process.env.* name referenced by non-test chat service source. */
function chatEnvVars(): string[] {
  const files: string[] = [];
  collectTsFiles(join(REPO_ROOT, "chat"), files);
  const vars = new Set<string>();
  for (const file of files) {
    for (const name of extractEnvVarNames(readFileSync(file, "utf-8"))) {
      vars.add(name);
    }
  }
  return [...vars].sort();
}

describe("docs/chat-service.md", () => {
  it("finds the chat env vars to check", () => {
    expect(chatEnvVars()).toContain("DATABASE_URL_SHIPWRIGHT_CHAT");
  });

  it("lists every chat env var in the Environment table", () => {
    const missing = chatEnvVars().filter(
      (name) => !guide.includes(`| \`${name}\` |`),
    );
    expect(missing).toEqual([]);
  });

  it("links the committed openapi.json, which exists", () => {
    expect(guide).toContain("(../chat/openapi.json)");
    expect(existsSync(join(REPO_ROOT, "chat", "openapi.json"))).toBe(true);
  });

  it("documents the auth model", () => {
    expect(guide).toContain("## Authentication");
    expect(guide).toContain("Bearer");
  });
});
