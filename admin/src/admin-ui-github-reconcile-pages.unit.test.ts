/**
 * admin/src/admin-ui-github-reconcile-pages.unit.test.ts
 * Unit tests for the GHE-3.5 Reconcile card and its plan/apply fragments, and
 * for the card's placement in renderAgentDetailPage (inert, plan, over-cap).
 */

import { describe, expect, test } from "bun:test";
import {
  type GithubReconcilePlanView,
  renderGithubReconcileApplyResult,
  renderGithubReconcileCard,
  renderGithubReconcilePlanResult,
} from "./admin-ui-github-reconcile-pages.ts";
import { type AgentDetail, renderAgentDetailPage } from "./admin-ui-pages.ts";

const AGENT: AgentDetail = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  selfHosted: false,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
  repos: [],
  authorAllowlist: [],
  patchAuthorAllowlist: [],
  restrictSlackToMembers: false,
  specialty: "coding",
  missingRequiredEnv: [],
  autoPostReviews: true,
  allowSelfReview: false,
  minConfidence: 75,
  maxFindings: 5,
  cleanupMergedWorktrees: true,
  cleanupAfterDays: 14,
};

function page(
  isAdmin: boolean,
  configured: boolean,
  githubUsername: string | null,
): string {
  return renderAgentDetailPage(
    { ...AGENT, githubUsername },
    {},
    [],
    [],
    [],
    [],
    [],
    "u@x.com",
    isAdmin,
    { timezone: "UTC", githubEnterpriseConfigured: configured },
  );
}

const plan = (over: Partial<GithubReconcilePlanView> = {}) =>
  ({
    status: "planned",
    planHash: "hash-1",
    empty: false,
    diff: {
      installationAdds: ["acme/new"],
      installationRemoves: ["acme/old"],
      configAdds: ["acme/new"],
      configRemoves: ["acme/old"],
    },
    ...over,
  }) as GithubReconcilePlanView;

describe("Reconcile card — inert state", () => {
  test("absent when no username is bound", () => {
    const html = page(true, true, null);
    expect(html).not.toContain("github-reconcile-card");
    expect(html).not.toContain("Reconcile");
  });

  test("absent when the apps are not configured", () => {
    expect(page(true, false, "octo")).not.toContain("github-reconcile-card");
  });

  test("absent for a non-admin", () => {
    expect(page(false, true, "octo")).not.toContain("github-reconcile-card");
  });

  test("present for an admin with a username and configured apps", () => {
    const html = page(true, true, "octo");
    expect(html).toContain('id="github-reconcile-card"');
    expect(html).toContain('id="github-reconcile-plan-btn"');
    expect(html).toContain('name="addRepos"');
  });

  test("card wires escaped plan and apply URLs and holds no key material", () => {
    const html = renderGithubReconcileCard('a"b');
    expect(html).toContain("/admin/agents/a&quot;b/github-reconcile/plan");
    expect(html).toContain("/admin/agents/a&quot;b/github-reconcile/apply");
    expect(html).not.toMatch(/BEGIN|token|private/i);
  });
});

describe("renderGithubReconcilePlanResult — plan state", () => {
  test("renders the diff table, hash and a confirm gate", () => {
    const html = renderGithubReconcilePlanResult(plan(), []);
    expect(html).toContain("acme/new");
    expect(html).toContain("acme/old");
    expect(html).toContain('data-plan-hash="hash-1"');
    expect(html).toContain('id="github-reconcile-confirm"');
    expect(html).toMatch(/id="github-reconcile-apply-btn"[^>]*disabled/);
    expect(html).not.toContain("github-reconcile-confirm-removals");
  });

  test("carries the named adds for apply", () => {
    const html = renderGithubReconcilePlanResult(plan(), ["acme/x", "acme/y"]);
    expect(html).toContain('data-add-repos="acme/x,acme/y"');
  });

  test("renders skip reasons, rejected adds, warnings and open work", () => {
    const html = renderGithubReconcilePlanResult(
      plan({
        skippedOrgs: [{ org: "beta", reason: "lookup app not installed" }],
        rejectedAdds: [{ repo: "zed/q", reason: "not accessible" }],
        warnings: ["careful <b>now</b>"],
        affectedOpenWork: [
          { id: "T-1", repo: "acme/old", title: "Fix <i>it</i>" },
        ],
      }),
      [],
    );
    expect(html).toContain("beta");
    expect(html).toContain("lookup app not installed");
    expect(html).toContain("zed/q");
    expect(html).toContain("careful &lt;b&gt;now&lt;/b&gt;");
    expect(html).toContain("T-1");
    expect(html).toContain("Fix &lt;i&gt;it&lt;/i&gt;");
    expect(html).not.toContain("<b>now</b>");
  });

  test("empty plan has nothing to apply", () => {
    const html = renderGithubReconcilePlanResult(
      plan({
        empty: true,
        diff: {
          installationAdds: [],
          installationRemoves: [],
          configAdds: [],
          configRemoves: [],
        },
      }),
      [],
    );
    expect(html).toContain("Nothing to change");
    expect(html).not.toContain("github-reconcile-apply-btn");
  });

  test("skipped plan shows the reason and no apply", () => {
    const html = renderGithubReconcilePlanResult(
      { status: "skipped", reason: "GitHub Apps are not configured" },
      [],
    );
    expect(html).toContain("GitHub Apps are not configured");
    expect(html).not.toContain("github-reconcile-apply-btn");
  });
});

describe("renderGithubReconcilePlanResult — over-cap confirm", () => {
  const many = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
  const over = plan({
    diff: {
      installationAdds: [],
      installationRemoves: many,
      configAdds: [],
      configRemoves: many,
    },
  });

  test("more than 10 config removals requires a second confirmation", () => {
    const html = renderGithubReconcilePlanResult(over, []);
    expect(html).toContain('data-over-cap="true"');
    expect(html).toContain('id="github-reconcile-confirm-removals"');
    expect(html).toContain("11 repos");
  });

  test("exactly 10 removals does not", () => {
    const ten = many.slice(0, 10);
    const html = renderGithubReconcilePlanResult(
      plan({
        diff: {
          installationAdds: [],
          installationRemoves: ten,
          configAdds: [],
          configRemoves: ten,
        },
      }),
      [],
    );
    expect(html).toContain('data-over-cap="false"');
    expect(html).not.toContain("github-reconcile-confirm-removals");
  });
});

describe("renderGithubReconcileApplyResult", () => {
  test.each([
    ["applied", "alert-success"],
    ["noop", "alert-warning"],
    ["failed", "alert-error"],
    ["skipped", "alert-warning"],
  ] as const)("%s", (status, cls) => {
    const html = renderGithubReconcileApplyResult({
      status,
      auditId: "aud-1",
      reason: "r <x>",
      error: "boom <x>",
    });
    expect(html).toContain(cls);
    expect(html).not.toContain("<x>");
  });

  test("applied shows the audit id", () => {
    expect(
      renderGithubReconcileApplyResult({ status: "applied", auditId: "aud-1" }),
    ).toContain("aud-1");
  });
});
