/**
 * plugins/agent-platform/skills/agent-admin/agent-admin.content.test.ts
 *
 * Keeps the generic agent-admin skill platform-only: no coding-specific
 * strings, every documented admin route exists in admin/src, and the
 * feature flags named in the skill are the ones the admin code reads.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
const spec = JSON.parse(
  readFileSync(join(ROOT, "admin/openapi.json"), "utf8"),
) as { paths: Record<string, Record<string, unknown>> };
// Mounted outside the OpenAPI spec: liveness probe and the flag-gated /doc.
const UNSPECCED_ROUTES = ["/health", "/doc"];
const specPaths = [...Object.keys(spec.paths), ...UNSPECCED_ROUTES];

describe("agent-admin SKILL.md is generic", () => {
  it("has no shipwright:check-* preCheck names", () => {
    expect(skill).not.toMatch(/shipwright:check-/);
  });

  it("does not reference coding-specialty-defaults", () => {
    expect(skill).not.toContain("coding-specialty-defaults");
  });

  it("does not document coding-only metrics or dashboard routes", () => {
    expect(skill).not.toContain("/metrics/");
    expect(skill).not.toContain("/dashboard");
  });
});

describe("agent-admin SKILL.md routes exist in admin/src", () => {
  const documented = new Set<string>();
  for (const m of skill.matchAll(/\$SHIPWRIGHT_API_URL(\/[^\s"?\\]*)/g)) {
    documented.add(
      m[1]
        .replace(/\$SHIPWRIGHT_AGENT_ID|\{agentId\}|\{targetAgentId\}/g, "{id}")
        .replace(/\/envs\/[A-Z_]+$/, "/envs/{key}")
        .replace(/\/repos\/my-org\/my-repo$/, "/repos/{owner}/{name}")
        .replace(/\/agents\/\{id\}\/(\w+)\/\{(\w+)\}$/, "/agents/{id}/$1/{$2}")
        .replace(/\/envs\/GH_TOKEN$/, "/envs/{key}"),
    );
  }

  it("finds documented routes", () => {
    expect(documented.size).toBeGreaterThan(10);
  });

  it.each([...documented])("route %s is served by admin/src", (route) => {
    const normalized = route.replace(/\/\{(cronId|toolId|tokenId)\}/g, "/{$1}");
    expect(specPaths, route).toContain(normalized);
  });

  it.each(["platform.read", "platform.ops"])("names scope %s", (scope) => {
    expect(skill).toContain(scope);
  });

  it.each([
    "SHIPWRIGHT_AGENT_ASK_ENABLED",
    "SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED",
    "SHIPWRIGHT_ADMIN_DOC_ENABLED",
  ])("names flag %s", (flag) => {
    expect(skill).toContain(flag);
  });
});
