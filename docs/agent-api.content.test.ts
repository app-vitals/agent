/**
 * docs/agent-api.content.test.ts
 *
 * Content-layer tests for docs/agent-api.md: it must list every
 * PLATFORM_OPS_ROUTES entry (method + path) and every feature-flag name read
 * by admin/src/*-config.ts. Pure file reads plus the exported constant.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_OPS_ROUTES } from "../admin/src/api-auth.ts";

const DOCS_DIR = import.meta.dir;
const ADMIN_SRC = join(DOCS_DIR, "..", "admin", "src");

const apiDoc = readFileSync(join(DOCS_DIR, "agent-api.md"), "utf-8");

/**
 * Feature-flag names (SHIPWRIGHT_*_ENABLED / *_ALLOWLIST) referenced by
 * admin/src/*-config.ts, plus the /doc flag from platform-doc-route.ts.
 * Tuning knobs in the same files (intervals, resource limits) are documented
 * in configuration-agent.md, not here.
 */
function configFlagNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(ADMIN_SRC)) {
    if (!file.endsWith("-config.ts") && file !== "platform-doc-route.ts") {
      continue;
    }
    const source = readFileSync(join(ADMIN_SRC, file), "utf-8");
    for (const m of source.matchAll(
      /\bSHIPWRIGHT_[A-Z0-9_]+_(?:ENABLED|ALLOWLIST)\b/g,
    )) {
      if (m[0]) names.add(m[0]);
    }
  }
  return [...names].sort();
}

describe("docs/agent-api.md", () => {
  it("lists every PLATFORM_OPS_ROUTES entry as a table row (method + path)", () => {
    const missing = PLATFORM_OPS_ROUTES.filter(
      (r) => !apiDoc.includes(`| \`${r.method}\` | \`${r.path}\` |`),
    ).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it("mentions every flag name used in admin/src/*-config.ts", () => {
    const flags = configFlagNames();
    expect(flags.length).toBeGreaterThan(0);
    const missing = flags.filter((f) => !apiDoc.includes(f));
    expect(missing).toEqual([]);
  });
});
