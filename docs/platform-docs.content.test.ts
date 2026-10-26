/**
 * docs/platform-docs.content.test.ts
 *
 * Content-layer tests for the platform halves of the docs split out of the
 * shipwright repo: docs/agent-key-files.md and docs/configuration-agent.md.
 * Pure file reads, no I/O boundary beyond the repo checkout.
 *
 * Acceptance criteria covered:
 *   1. Every path in the first column of the key-files tables exists in this
 *      repo.
 *   2. The credential-helper row names SHIPWRIGHT_GH_OWNER (not the `path=`
 *      git sends) as the owner source, and the nonexistent resolve-gh-owner.ts
 *      is not mentioned.
 *   3. The configuration doc lists each platform var once and no coding-only
 *      var (those stay in the shipwright repo's configuration-agent.md).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = import.meta.dir;
const REPO_ROOT = join(DOCS_DIR, "..");

const keyFiles = readFileSync(join(DOCS_DIR, "agent-key-files.md"), "utf-8");
const configuration = readFileSync(
  join(DOCS_DIR, "configuration-agent.md"),
  "utf-8",
);

/** First-column backticked cells of every markdown table row. */
function firstColumnCells(markdown: string): string[] {
  const cells: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\| `([^`]+)` \|/.exec(line);
    if (match?.[1]) cells.push(match[1]);
  }
  return cells;
}

/**
 * Env vars and per-agent fields that only coding-specialty code reads. They are
 * documented in the shipwright repo's configuration-agent.md and must not
 * appear in this repo's platform doc. (`<PHASE>` is a literal placeholder.)
 */
const CODING_ONLY_NAMES = [
  // per-agent policy fields owned by the coding extension
  "reviewAuthorAllowlist",
  "patchAuthorAllowlist",
  "autoPostReviews",
  "allowSelfReview",
  "minConfidence",
  "maxFindings",
  // loop orchestrator / reconciler / census
  "SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED",
  "SHIPWRIGHT_AGENT_PR_CENSUS_ENABLED",
  "SHIPWRIGHT_AGENT_PR_CENSUS_INTERVAL_MS",
  "SHIPWRIGHT_RECONCILER_DELAY_MS",
  "SHIPWRIGHT_RECONCILER_UPDATED_SINCE_WINDOW_MS",
  "SHIPWRIGHT_RECONCILER_PR_OPEN_TASK_BATCH_SIZE",
  "SHIPWRIGHT_RECONCILER_SCOPE_DEGRADED_RETRY_DELAY_MS",
  "SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS",
  "SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS",
  "SHIPWRIGHT_LOOP_<PHASE>_ALT_COMMAND",
  "SHIPWRIGHT_LOOP_<PHASE>_ALT_SHARE",
  // task store / metrics / MCP services (the chat service now lives in this repo)
  "DATABASE_URL_SHIPWRIGHT_TASK_STORE",
  "SHIPWRIGHT_TASK_STORE_URL",
  "SHIPWRIGHT_TASK_STORE_TOKEN",
  "SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN",
  "SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS",
  "SHIPWRIGHT_TASK_STORE_AGENTS_URL",
  "SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY",
  "SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS",
  "SHIPWRIGHT_TASK_STORE_WEBHOOK_URL",
  "SHIPWRIGHT_TASK_STORE_WEBHOOK_TOKEN",
  "SHIPWRIGHT_TASK_STORE_WEBHOOK_SIGNING_SECRET",
  "SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS",
  "SHIPWRIGHT_TASK_STORE_POOL_HOLD_THRESHOLD_MS",
  "SHIPWRIGHT_TASK_STORE_POOL_MONITOR_INTERVAL_MS",
  "SHIPWRIGHT_MCP_SERVER_TOKEN",
  "METRICS_ADMIN_APP_URL",
  "METRICS_DASHBOARD_DEV_AUTH",
  "TASK_STORE_SEED_ADMIN_TOKEN",
  // dev-only HITL tooling
  "SHIPWRIGHT_HITL_HOME",
  "SHIPWRIGHT_HITL_HOST",
  "SHIPWRIGHT_HITL_REPOS",
  "SHIPWRIGHT_HITL_AUTHORS",
  "SHIPWRIGHT_HITL_POLL_INTERVAL",
  "SHIPWRIGHT_HITL_LOG_FILE",
  "XDG_DATA_HOME",
];

function mentions(markdown: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(
    markdown,
  );
}

describe("docs/agent-key-files.md", () => {
  const paths = firstColumnCells(keyFiles);

  it("has key-file rows", () => {
    expect(paths.length).toBeGreaterThan(50);
  });

  it("lists each path once", () => {
    const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(duplicates).toEqual([]);
  });

  it("only lists paths that exist in this repo", () => {
    const missing = paths.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("does not mention the nonexistent resolve-gh-owner.ts", () => {
    expect(keyFiles).not.toContain("resolve-gh-owner");
  });

  it("documents the credential helper as owner-from-SHIPWRIGHT_GH_OWNER", () => {
    const row = keyFiles
      .split("\n")
      .find((l) =>
        l.startsWith("| `scripts/bin/git-credential-shipwright.sh`"),
      );
    expect(row).toBeDefined();
    expect(row).toContain("SHIPWRIGHT_GH_OWNER");
    expect(row).toContain("not** from the request path");
  });

  it("names no agent/src/ or coding-module paths", () => {
    expect(keyFiles).not.toContain("agent/src/");
    expect(keyFiles).not.toContain("admin/src/coding/");
    expect(keyFiles).not.toContain("plugins/shipwright");
  });
});

describe("docs/configuration-agent.md", () => {
  const names = firstColumnCells(configuration);

  it("has config rows", () => {
    expect(names.length).toBeGreaterThan(50);
  });

  it("lists each variable once", () => {
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });

  it("lists no coding-only variables", () => {
    const leaked = CODING_ONLY_NAMES.filter((n) => mentions(configuration, n));
    expect(leaked).toEqual([]);
  });
});
