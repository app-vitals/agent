import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { walk } from "./check-import-boundary.ts";

/**
 * PCD-6.1: coding.prisma and the CODING-OWNED Agent columns stay in the
 * platform schema (see docs/agent.md). This guard keeps their readers confined
 * to the extension seam and the agents API plumbing.
 */

const ROOT = resolve(import.meta.dir, "..");
const PLATFORM_DIRS = ["runtime", "admin", "lib", "chat"];
const NON_PRODUCTION = /\.(?:unit|integration|smoke|e2e)\.test\.|\.fixtures\./;

const CODING_MODELS = [
  "AgentWorkQueueSnapshot",
  "AgentPhaseMethodology",
  "SessionFollow",
  "SessionAlertState",
];
const CODING_COLUMNS = [
  "reviewAuthorAllowlist",
  "patchAuthorAllowlist",
  "autoPostReviews",
  "allowSelfReview",
  "minConfidence",
  "maxFindings",
];

/** Agents API plumbing and the extension seam that may carry coding columns. */
const COLUMN_ALLOWLIST = new Set([
  "admin/src/admin-ui-pages.ts",
  "admin/src/admin-ui.ts",
  "admin/src/agents-api.ts",
  "admin/src/agents.ts",
  "admin/src/api.ts",
  "admin/src/openapi-schemas.ts",
  "lib/admin-types.ts",
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Platform files (relative paths) whose code matches any of the names. */
export function filesReferencing(root: string, names: string[]): string[] {
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const files: string[] = [];
  for (const dir of PLATFORM_DIRS) walk(join(root, dir), files);
  return files
    .filter((f) => !NON_PRODUCTION.test(f))
    .filter((f) => pattern.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(root, f).split(sep).join("/"))
    .sort();
}

describe("coding schema guard (PCD-6.1)", () => {
  it("no platform module reads the coding.prisma models", () => {
    const camel = CODING_MODELS.map((m) => m[0]?.toLowerCase() + m.slice(1));
    const allowed = new Set(["lib/admin-types.ts"]); // generated OpenAPI types
    const offenders = filesReferencing(ROOT, [
      ...CODING_MODELS,
      ...camel,
    ]).filter((f) => !allowed.has(f));
    expect(offenders).toEqual([]);
  });

  it("only the agents API plumbing reads the coding-owned Agent columns", () => {
    const offenders = filesReferencing(ROOT, CODING_COLUMNS).filter(
      (f) => !COLUMN_ALLOWLIST.has(f),
    );
    expect(offenders).toEqual([]);
  });

  it("detects a non-allowlisted module that reads a coding model", () => {
    const {
      mkdtempSync,
      mkdirSync,
      writeFileSync,
      rmSync,
    } = require("node:fs");
    const { tmpdir } = require("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "coding-schema-guard-"));
    try {
      mkdirSync(join(tmp, "runtime"), { recursive: true });
      writeFileSync(
        join(tmp, "runtime/x.ts"),
        "export const f = (db) => db.sessionFollow.findMany();\n",
      );
      expect(filesReferencing(tmp, ["sessionFollow"])).toEqual([
        "runtime/x.ts",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
