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
  renderGithubInstallCard,
  renderGithubOrgsFragment,
  renderGithubUninstallConfirm,
  renderGithubUsernameRow,
} from "./admin-ui-github-identity-pages.ts";
import {
  AGENT_SECTIONS,
  type AgentDetail,
  renderAgentDetailPage as renderAgentDetailSection,
} from "./admin-ui-pages.ts";

/**
 * Renders every agent detail section (SGL-1.2) concatenated, so card-level
 * assertions don't depend on which section a card lives in. Pass
 * `opts.section` to render a single section instead.
 */
function renderAgentDetailPage(
  ...args: Parameters<typeof renderAgentDetailSection>
): string {
  const opts = args[9];
  if (opts?.section) return renderAgentDetailSection(...args);
  return AGENT_SECTIONS.map((section) => {
    const a = [...args] as typeof args;
    a[9] = { ...opts, section };
    return renderAgentDetailSection(...a);
  }).join("\n");
}

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

describe("Install on org block (GHC-1.2)", () => {
  const orgs = (over: Record<string, unknown> = {}) => ({
    configured: true,
    agentAppSlug: "agent-app",
    agentAppReason: null,
    orgs: [
      {
        id: 1,
        login: "acme",
        lookupAppInstalled: true,
        agentAppInstalled: false,
      },
      {
        id: 2,
        login: "<b>x</b>",
        lookupAppInstalled: false,
        agentAppInstalled: true,
      },
    ],
    ...over,
  });

  test("card lazy-loads the fragment and is gated like the sync card", () => {
    expect(renderGithubInstallCard("agent-123")).toContain(
      "/admin/agents/agent-123/github-orgs",
    );
    expect(page(true, true)).toContain("Install on org");
    expect(page(true, false)).not.toContain("Install on org");
    expect(page(false, true)).not.toContain("Install on org");
  });

  test("lists orgs with status; not installed gets an enabled Install form", () => {
    const html = renderGithubOrgsFragment("agent-123", orgs());
    expect(html).toContain("acme");
    expect(html).toContain(
      'action="/admin/agents/agent-123/github-orgs/acme/install"',
    );
    expect(html).toContain("Installed");
    expect(html).toContain("Not installed");
    expect(html).not.toMatch(/ disabled/);
    expect(html).not.toContain('name="agentId"');
  });

  test("installed org shows Uninstall, not installed keeps Install", () => {
    const html = renderGithubOrgsFragment("agent-123", orgs());
    expect(html.match(/>Uninstall<\/button>/g)?.length).toBe(1);
    expect(html).toContain(
      "/admin/agents/agent-123/github-orgs/%3Cb%3Ex%3C%2Fb%3E/uninstall-confirm",
    );
    expect(html.match(/>Install<\/button>/g)?.length).toBe(1);
  });

  test("Uninstall is disabled when the agent App reason is set", () => {
    const html = renderGithubOrgsFragment(
      "agent-123",
      orgs({ agentAppReason: "nope" }),
    );
    expect(html).toMatch(/data-org="[^"]*" disabled>Uninstall</);
  });

  test("unconfigured installer renders no Uninstall", () => {
    expect(
      renderGithubOrgsFragment("a", { configured: false, orgs: orgs().orgs }),
    ).not.toContain("Uninstall");
  });

  test("uninstall confirm lists repos and open work, escaped", () => {
    const html = renderGithubUninstallConfirm("agent-123", {
      org: "acme",
      repos: ["acme/<r>"],
      openWork: [{ id: "T-1", repo: "acme/<r>", title: "Do it" }],
    });
    expect(html).toContain("acme/&lt;r&gt;");
    expect(html).toContain("T-1");
    expect(html).toContain('action="/admin/agents/agent-123/github-orgs/acme/uninstall"');
    expect(html).not.toContain("confirmRemovals");
  });

  test("uninstall confirm carries confirmRemovals for more than 10 repos", () => {
    const repos = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
    expect(
      renderGithubUninstallConfirm("a", { org: "acme", repos, openWork: [] }),
    ).toContain('name="confirmRemovals"');
  });

  test("installed org has no Install button; names are escaped", () => {
    const html = renderGithubOrgsFragment("agent-123", orgs());
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html.match(/>Install<\/button>/g)?.length).toBe(1);
  });

  test("agentAppReason is shown and disables Install", () => {
    const html = renderGithubOrgsFragment(
      "agent-123",
      orgs({ agentAppReason: "App <private>" }),
    );
    expect(html).toContain("App &lt;private&gt;");
    expect(html).toContain("disabled");
  });

  test("unconfigured and empty states", () => {
    expect(
      renderGithubOrgsFragment("a", { configured: false, orgs: [] }),
    ).toContain("not configured");
    expect(renderGithubOrgsFragment("a", orgs({ orgs: [] }))).toContain(
      "No installable organizations",
    );
  });
});

describe("GitHub identity surfaces by App state (GFU-2.2)", () => {
  const pageState = (appsState?: "both" | "lookup_only" | "lookup_missing") =>
    renderAgentDetailPage(
      { ...AGENT, githubUsername: "octo" },
      { GH_APP_ID: "1" },
      [],
      [],
      [],
      [],
      [],
      "u@x.com",
      true,
      { timezone: "UTC", ...(appsState ? { githubAppsState: appsState } : {}) },
    );

  test("both: preview, sync button and the install org list", () => {
    const html = pageState("both");
    expect(html).toContain('id="github-access-btn"');
    expect(html).toContain('id="github-sync-btn"');
    expect(html).toContain('id="github-install-result"');
    expect(html).not.toContain('data-reason="lookup-only"');
  });

  test("lookup-only: preview stays, Sync and Install explain the installer need", () => {
    const html = pageState("lookup_only");
    expect(html).toContain('id="github-access-btn"');
    expect(html).toContain('data-reason="lookup-only"');
    expect(html).not.toContain('id="github-sync-btn"');
    expect(html).not.toContain('id="github-install-result"');
    expect(html).toContain("Install on org");
  });

  test("lookup-missing: only the Sync card, saying the lookup App is missing", () => {
    const html = pageState("lookup_missing");
    expect(html).toContain('data-reason="lookup-missing"');
    expect(html).not.toContain('id="github-access-btn"');
    expect(html).not.toContain("Install on org");
  });

  test("no state: hidden; legacy githubEnterpriseConfigured: true means both", () => {
    expect(pageState()).not.toContain('id="github-installation-card"');
    expect(page(true, true)).toContain('id="github-installation-card"');
    expect(page(true, true)).not.toContain('data-reason="lookup-only"');
  });

  test("access preview: unconfigured is the lookup-missing message", () => {
    const html = renderGithubAccessResult({ status: "unconfigured" });
    expect(html).toContain('data-reason="lookup-missing"');
    expect(html).toContain("lookup GitHub App is not configured");
    expect(html).not.toContain("installer");
  });

  test("access preview: escapes the username and org values", () => {
    const html = renderGithubAccessResult({
      status: "user_not_found",
      access: {
        username: "<img src=x>",
        outcome: "user_not_found",
        userVerified: false,
        orgs: [],
        unresolved: 0,
        complete: true,
        checkedAt: "2026-11-10T00:00:00Z",
      },
    } as GithubAccessPreviewView);
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  test("install card: lookup-only explains; both lazy-loads; id escaped", () => {
    const only = renderGithubInstallCard('a"><i>', "lookup_only");
    expect(only).toContain('data-reason="lookup-only"');
    expect(only).not.toContain("github-install-result");
    expect(only).not.toContain("<i>");
    expect(renderGithubInstallCard("a", "both")).toBe(
      renderGithubInstallCard("a"),
    );
  });

  test("orgs fragment: installer-unconfigured names the installer and its enterprise need", () => {
    const html = renderGithubOrgsFragment("a", { configured: false, orgs: [] });
    expect(html).toContain("The installer GitHub App is not configured.");
    expect(html).toContain("enterprise installer App");
    expect(html).not.toContain("lookup");
  });
});
