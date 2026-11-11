/**
 * admin/src/admin-ui-github-identity-pages.unit.test.ts
 * Unit tests for the GHE-2.5 GitHub identity row, preview card and result
 * renderers, and for their placement in renderAgentDetailPage.
 */

import { describe, expect, test } from "bun:test";
import {
  type GithubAccessPreviewView,
  renderGithubAccessCard,
  renderGithubAccessResult,
  renderGithubUsernameRow,
} from "./admin-ui-github-identity-pages.ts";
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
  configured: boolean | undefined,
  githubUsername?: string | null,
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
    {
      timezone: "UTC",
      ...(configured === undefined
        ? {}
        : { githubEnterpriseConfigured: configured }),
    },
  );
}

const analysis = (
  over: Partial<NonNullable<GithubAccessPreviewView["access"]>>,
) =>
  ({
    status: "ok",
    access: {
      username: "octo",
      outcome: "ok",
      userVerified: true,
      orgs: [],
      unresolved: 0,
      complete: true,
      checkedAt: "2026-11-10T00:00:00Z",
      ...over,
    },
  }) as GithubAccessPreviewView;

describe("agent detail — identity card (GHE-2.5)", () => {
  test("card is retitled Owner & identities", () => {
    const html = page(true, false);
    expect(html).toContain(
      '<div class="card-title">Owner &amp; identities</div>',
    );
    expect(html).not.toContain("Owner &amp; Anthropic identity");
  });

  test("hidden when enterprise apps are not configured", () => {
    for (const cfg of [false, undefined]) {
      const html = page(true, cfg);
      expect(html).not.toContain("GitHub username");
      expect(html).not.toContain("Preview access");
      expect(html).not.toContain("github-username");
    }
  });

  test("hidden for a non-admin even when configured", () => {
    const html = page(false, true, "octo");
    expect(html).not.toContain("GitHub username");
    expect(html).not.toContain("Preview access");
  });

  test("admin with configured apps sees save, clear and the preview card", () => {
    const html = page(true, true, "octo");
    expect(html).toContain("GitHub username");
    expect(html).toContain('action="/admin/agents/agent-123/github-username"');
    expect(html).toContain('value="octo"');
    expect(html).toContain("Save");
    expect(html).toContain("Clear");
    expect(html).toContain('id="github-access-btn"');
    expect(html).toContain("Preview access");
  });

  test("clear is omitted when no username is bound", () => {
    const html = page(true, true, null);
    expect(html).not.toContain('id="clear-github-username"');
  });

  test("username is escaped", () => {
    const row = renderGithubUsernameRow("a", '"><script>x</script>');
    expect(row).not.toContain("<script>x</script>");
  });

  test("card renders no key material", () => {
    expect(renderGithubAccessCard("a")).not.toMatch(/BEGIN|token|private/i);
  });
});

describe("renderGithubAccessResult", () => {
  test("empty org list", () => {
    const html = renderGithubAccessResult(analysis({}));
    expect(html).toContain("No organizations to check.");
    expect(html).not.toContain("Partial results");
  });

  test("complete: table grouped by org with push marker and ok badge", () => {
    const html = renderGithubAccessResult(
      analysis({
        orgs: [
          {
            org: "acme",
            status: "ok",
            unresolved: 0,
            repos: [
              { fullName: "acme/api", level: "write", canPush: true },
              { fullName: "acme/docs", level: "read", canPush: false },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("acme");
    expect(html).toContain("acme/api");
    expect(html).toContain("write");
    expect(html).toContain("badge-green");
    expect(html.match(/title="Can push"/g)?.length).toBe(1);
    expect(html).not.toContain("Partial results");
  });

  test.each([
    ["lookup_app_not_installed", "lookup app not installed"],
    ["rate_limited", "rate-limited"],
    ["partial", "partial"],
    ["error", "error"],
  ] as const)("status %s renders a badge and the warning", (status, label) => {
    const html = renderGithubAccessResult(
      analysis({
        complete: false,
        unresolved: 3,
        orgs: [{ org: "acme", status, repos: [], unresolved: 3 }],
      }),
    );
    expect(html).toContain(`>${label}</span>`);
    expect(html).toContain("Partial results");
  });

  test("partial org with a reason shows the reason in the banner", () => {
    const html = renderGithubAccessResult(
      analysis({
        complete: false,
        orgs: [
          {
            org: "acme",
            status: "partial",
            repos: [],
            unresolved: 0,
            reason: "lookup app installed on selected repositories only <x>",
          },
        ],
      }),
    );
    expect(html).toContain("Partial results");
    expect(html).toContain("selected repositories only &lt;x&gt;");
    expect(html).not.toContain("<x>");
  });

  test("incomplete with all orgs ok still warns", () => {
    const html = renderGithubAccessResult(
      analysis({
        complete: false,
        orgs: [{ org: "a", status: "ok", repos: [], unresolved: 0 }],
      }),
    );
    expect(html).toContain("Partial results");
  });

  test("user not found", () => {
    const html = renderGithubAccessResult({
      status: "user_not_found",
      access: {
        username: "ghost",
        outcome: "user_not_found",
        userVerified: true,
        orgs: [],
        unresolved: 0,
        complete: false,
        checkedAt: "x",
      },
    });
    expect(html).toContain("was not found");
    expect(html).toContain("ghost");
    expect(html).not.toContain("<table");
  });

  test("escapes org and repo names", () => {
    const html = renderGithubAccessResult(
      analysis({
        orgs: [
          {
            org: "<b>o</b>",
            status: "ok",
            unresolved: 0,
            repos: [{ fullName: "<i>r</i>", level: "read", canPush: false }],
          },
        ],
      }),
    );
    expect(html).not.toContain("<b>o</b>");
    expect(html).not.toContain("<i>r</i>");
  });
});
