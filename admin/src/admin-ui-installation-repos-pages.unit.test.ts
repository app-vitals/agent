/**
 * admin/src/admin-ui-installation-repos-pages.unit.test.ts
 * Unit tests for the pure IRM-1.4 helpers and escaping.
 */

import { describe, expect, it } from "bun:test";
import {
  APP_ID_MISMATCH_MESSAGE,
  actuallyBlockedWork,
  NO_USERNAME_REASON,
  renderGithubSyncCard,
  renderInstallationReposBody,
  renderInstallationSyncStatus,
  renderOpenWorkByRepo,
  renderSyncConfirm,
  renderSyncResult,
  uncoveredRepos,
} from "./admin-ui-installation-repos-pages.ts";
import { MISSING_APP_ID_REASON } from "./installation-ports.ts";

describe("uncoveredRepos", () => {
  it("returns agent repos missing from the installation, case-insensitively", () => {
    expect(
      uncoveredRepos(["Acme/Api", "acme/web", "x/y"], ["acme/api", "acme/web"]),
    ).toEqual(["x/y"]);
  });
  it("returns nothing when all are covered", () => {
    expect(uncoveredRepos(["a/b"], ["a/b"])).toEqual([]);
  });
});

describe("actuallyBlockedWork", () => {
  const seen = [
    { id: "a/b#1", repo: "a/b" },
    { id: "t1", repo: "c/d" },
    { id: "t2", repo: "e/f" },
  ];
  it("keeps only work on removed repos whose blocking did not warn", () => {
    expect(
      actuallyBlockedWork(
        seen,
        ["a/b", "c/d"],
        ["open work for c/d was not blocked: boom"],
      ).map((w) => w.id),
    ).toEqual(["a/b#1"]);
  });
});

describe("renderOpenWorkByRepo", () => {
  it("groups per repo, links PR ids and escapes titles and ids", () => {
    const html = renderOpenWorkByRepo(
      [
        { id: "a/b#1", repo: "a/b", title: "<script>" },
        { id: "<id>", repo: "a/b" },
      ],
      "H",
      "none",
    );
    expect(html.match(/font-weight:600">a\/b</g)?.length).toBe(1);
    expect(html).toContain('href="https://github.com/a/b/pull/1"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;id&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("renderGithubSyncCard", () => {
  const ok = { hasAppId: true, githubUsername: "octo" };

  it("has one Sync button and no text input", () => {
    const html = renderGithubSyncCard("a1", ok);
    expect(html).toContain('id="github-installation-card"');
    expect(html).toContain('id="github-sync-btn"');
    expect(html).toContain('data-url="/admin/agents/a1/github-sync/confirm"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
  });

  it("shows the missing-App-id reason instead of the button", () => {
    const html = renderGithubSyncCard("a1", {
      hasAppId: false,
      githubUsername: "octo",
    });
    expect(html).toContain('data-reason="missing-app-id"');
    expect(html).toContain(MISSING_APP_ID_REASON);
    expect(html).not.toContain('id="github-sync-btn"');
  });

  it("shows the no-username reason instead of the button", () => {
    for (const githubUsername of [null, undefined, "  "]) {
      const html = renderGithubSyncCard("a1", {
        hasAppId: true,
        githubUsername,
      });
      expect(html).toContain('data-reason="no-username"');
      expect(html).toContain(NO_USERNAME_REASON);
      expect(html).not.toContain('id="github-sync-btn"');
    }
  });

  it("missing App id wins over a missing username", () => {
    const html = renderGithubSyncCard("a1", { hasAppId: false });
    expect(html).toContain('data-reason="missing-app-id"');
    expect(html).not.toContain('data-reason="no-username"');
  });
});

describe("renderInstallationReposBody", () => {
  const view = {
    orgs: [
      {
        org: "acme",
        repos: [{ fullName: "acme/<x>", userCanPush: true }],
      },
    ],
  };

  it("lists app repos without any per-repo action", () => {
    const html = renderInstallationReposBody(view);
    expect(html).toContain("acme/&lt;x&gt;");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("data-action=");
  });

  it("says not installed when the org list is empty", () => {
    const html = renderInstallationReposBody({ orgs: [] });
    expect(html).toContain("not installed on any organization");
    expect(html).not.toContain('data-reason="app-id-mismatch"');
  });

  it("shows a distinct GH_APP_ID mismatch message", () => {
    const html = renderInstallationReposBody(
      { orgs: [] },
      { appIdMismatch: true },
    );
    expect(html).toContain('data-reason="app-id-mismatch"');
    expect(html).toContain(APP_ID_MISMATCH_MESSAGE);
    expect(html).not.toContain("not installed on any organization");
  });
});

describe("renderSyncConfirm", () => {
  const preview = {
    status: "previewed" as const,
    appAdds: ["acme/new"],
    appRemoves: ["acme/old"],
    agentRemoves: ["acme/gone"],
    skippedOrgs: [{ org: "zed", reason: "access listing is incomplete" }],
    openWork: [{ id: "acme/old#4", repo: "acme/old", title: "Fix <b>" }],
    warnings: ["w1"],
  };

  it("lists adds, removes, agent removes, blocked work and one confirm", () => {
    const html = renderSyncConfirm("a1", preview);
    expect(html).toContain('data-list="app-adds"');
    expect(html).toContain("acme/new");
    expect(html).toContain('data-list="app-removes"');
    expect(html).toContain("acme/old");
    expect(html).toContain('data-list="agent-removes"');
    expect(html).toContain("acme/gone");
    expect(html).toContain('href="https://github.com/acme/old/pull/4"');
    expect(html).toContain("Fix &lt;b&gt;");
    expect(html).toContain("zed");
    expect(html).toContain("w1");
    expect(html.match(/id="github-sync-confirm-btn"/g)?.length).toBe(1);
    expect(html).toContain(
      'data-url="/admin/agents/a1/github-sync/apply-confirmed"',
    );
    expect(html).not.toContain("github-sync-confirm-removals");
  });

  it("carries the exact confirmed lists, escaped", () => {
    const html = renderSyncConfirm("a1", preview);
    const m = /data-body="([^"]*)"/.exec(html);
    const body = JSON.parse(
      (m?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    );
    expect(body).toEqual({
      appAdds: ["acme/new"],
      appRemoves: ["acme/old"],
      agentRemoves: ["acme/gone"],
    });
  });

  it("requires the over-cap checkbox for more than 10 removals", () => {
    const many = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
    const html = renderSyncConfirm("a1", {
      ...preview,
      appRemoves: many,
      agentRemoves: [],
    });
    expect(html).toContain('id="github-sync-confirm-removals"');
    expect(html).toContain("disabled");
  });

  it("counts a repo removed from both places once", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `acme/r${i}`);
    const html = renderSyncConfirm("a1", {
      ...preview,
      appRemoves: ten,
      agentRemoves: ten,
    });
    expect(html).not.toContain("github-sync-confirm-removals");
  });

  it("says in sync when nothing would change, with no confirm", () => {
    const html = renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: [],
      appRemoves: [],
      agentRemoves: [],
    });
    expect(html).toContain('data-sync="in-sync"');
    expect(html).not.toContain("github-sync-confirm-btn");
  });

  it("shows the reason for a skipped preview", () => {
    const html = renderSyncConfirm("a1", {
      status: "skipped",
      reason: "GitHub user not found",
    });
    expect(html).toContain('data-sync="skipped"');
    expect(html).toContain("GitHub user not found");
    expect(html).not.toContain("github-sync-confirm-btn");
  });
});

describe("renderSyncResult", () => {
  it("reports what changed, what was left alone and blocked work", () => {
    const html = renderSyncResult(
      {
        status: "applied",
        appAdds: ["acme/new"],
        appRemoves: [],
        agentRemoves: ["acme/gone"],
        notApplied: [{ repo: "acme/x", reason: "still pushable" }],
        warnings: ["careful"],
      },
      [{ id: "acme/gone#1", repo: "acme/gone" }],
    );
    expect(html).toContain("acme/new");
    expect(html).toContain("acme/gone");
    expect(html).toContain("acme/x");
    expect(html).toContain("still pushable");
    expect(html).toContain("careful");
    expect(html).toContain("were blocked");
  });

  it("covers noop and skipped", () => {
    expect(renderSyncResult({ status: "noop" }, [])).toContain(
      "Nothing was changed",
    );
    expect(
      renderSyncResult({ status: "skipped", reason: "no user" }, []),
    ).toContain("no user");
  });
});

describe("skipped orgs and the in-sync state", () => {
  const skipped = [{ org: "zed", reason: "access listing is incomplete" }];
  const dupe = "zed: skipped (access listing is incomplete)";

  it("warns, not in-sync, when every org was skipped and nothing changes", () => {
    const html = renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: [],
      appRemoves: [],
      agentRemoves: [],
      skippedOrgs: skipped,
      warnings: [dupe],
    });
    expect(html).toContain('data-sync="nothing-synced"');
    expect(html).toContain("Nothing was synced: 1 org(s) skipped, see below");
    expect(html).not.toContain('data-sync="in-sync"');
    expect(html).not.toContain("Already in sync");
    expect(html).toContain('data-skipped-orgs="1"');
    expect(html).not.toContain("github-sync-confirm-btn");
  });

  it("still confirms changes when some orgs were skipped", () => {
    const html = renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: ["acme/new"],
      skippedOrgs: skipped,
      warnings: [dupe],
    });
    expect(html).toContain('data-sync="confirm"');
    expect(html).toContain('data-skipped-orgs="1"');
    expect(html).not.toContain('data-sync="nothing-synced"');
  });

  it("keeps the green in-sync state when no org was skipped", () => {
    const html = renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: [],
      appRemoves: [],
      agentRemoves: [],
      skippedOrgs: [],
    });
    expect(html).toContain('data-sync="in-sync"');
    expect(html).not.toContain("nothing-synced");
  });

  it("reports a skipped org once in the preview, keeping other warnings", () => {
    const html = renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: ["acme/new"],
      skippedOrgs: skipped,
      warnings: [dupe, "other warning"],
    });
    expect(html).not.toContain(dupe);
    expect(html).toContain("other warning");
    expect(html.match(/zed/g)).toHaveLength(1);
  });

  it("reports a skipped org once in the apply result, keeping other warnings", () => {
    const html = renderSyncResult(
      {
        status: "applied",
        skippedOrgs: skipped,
        warnings: [dupe, "other warning"],
      },
      [],
    );
    expect(html).not.toContain(dupe);
    expect(html).toContain("other warning");
    expect(html).toContain('data-skipped-orgs="1"');
  });
});

describe("skipped-org detail", () => {
  const render = (detail?: Record<string, unknown>, org = "zed") =>
    renderSyncConfirm("a1", {
      status: "previewed",
      appAdds: ["acme/new"],
      skippedOrgs: [{ org, reason: "access listing is incomplete", detail }],
    } as never);
  const line = (html: string) =>
    /data-skip-detail="1"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";

  it("renders exactly as before without detail", () => {
    const html = render(undefined);
    expect(html).toContain(
      '<div><span class="mono">zed</span>: access listing is incomplete</div>',
    );
    expect(html).not.toContain("data-skip-detail");
  });

  it("renders a complete crawl with repos missing an answer", () => {
    const html = render({
      lookupSnapshotFound: true,
      crawls: [{ completedAt: "2026-01-01T00:00:00.000Z" }],
      totalRepos: 31,
      reposWithOkAccess: 1,
      reposMissingAnswer: 30,
    });
    expect(line(html)).toBe(
      "Lookup crawl complete (31 repos). 30 repos have no access answer yet.",
    );
  });

  it("renders a missing lookup snapshot", () => {
    const html = render({ lookupSnapshotFound: false, crawls: [] });
    expect(line(html)).toBe("Lookup crawl not found for this App.");
  });

  it("renders a failed crawl with the next attempt", () => {
    const html = render({
      lookupSnapshotFound: true,
      crawls: [
        {
          completedAt: null,
          lastError: "rate limited",
          rateLimitResetAt: "2026-01-01T01:00:00.000Z",
        },
      ],
    });
    expect(line(html)).toBe(
      "Lookup crawl failed: rate limited; next attempt 2026-01-01T01:00:00.000Z.",
    );
  });

  it("renders an incomplete crawl without an error", () => {
    const html = render({ crawls: [{ completedAt: null }] });
    expect(line(html)).toBe("Lookup crawl not complete yet.");
  });

  it("renders error rows, terminal rows, row errors and oldest check", () => {
    const html = render({
      lookupSnapshotFound: true,
      crawls: [{ completedAt: "2026-01-01T00:00:00.000Z" }],
      totalRepos: 5,
      reposWithOkAccess: 2,
      reposMissingAnswer: 3,
      errorRows: 2,
      terminalRows: 1,
      maxAttempts: 4,
      rowErrors: ["boom", "bang"],
      oldestCheckedAt: "2025-12-01T00:00:00.000Z",
    });
    const t = line(html);
    expect(t).toContain("Lookup crawl complete (5 repos).");
    expect(t).toContain("3 repos have no access answer yet.");
    expect(t).toContain("2 repos errored.");
    expect(t).toContain("1 repo gave up (max 4 attempts).");
    expect(t).toContain("Row errors: boom; bang.");
    expect(t).toContain("Oldest check 2025-12-01T00:00:00.000Z.");
  });

  it("escapes lastError, rowErrors and org", () => {
    const html = render(
      {
        crawls: [{ completedAt: null, lastError: "<script>x</script>" }],
        rowErrors: ["<img onerror=1>"],
      },
      "<b>o</b>",
    );
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<b>o</b>");
    expect(html).toContain("&lt;script&gt;x");
    expect(html).toContain("&lt;img onerror=1&gt;");
  });

  it("renders in the apply result too", () => {
    const html = renderSyncResult(
      {
        status: "applied",
        skippedOrgs: [
          { org: "zed", reason: "r", detail: { lookupSnapshotFound: false } },
        ],
      },
      [],
    );
    expect(line(html)).toBe("Lookup crawl not found for this App.");
  });
});

describe("renderInstallationSyncStatus debug detail", () => {
  it("shows attempts, next attempt, lease holder and last tick on a failed snapshot, as an error", () => {
    const html = renderInstallationSyncStatus({
      complete: false,
      reposSeen: 3,
      totalCount: 10,
      lastError: "boom <b>",
      attempts: 3,
      nextAttemptAt: "2026-11-21T10:30:00.000Z",
      leaseHolder: "worker-1",
      lastTickAt: "2026-11-21T10:00:00.000Z",
    });
    expect(html).toContain("alert alert-warning");
    expect(html).toContain("Last error: boom &lt;b&gt;");
    expect(html).toContain("3 failed attempts");
    expect(html).toContain("Next attempt 2026-11-21 10:30 UTC");
    expect(html).toContain("Refreshing (worker-1)");
    expect(html).toContain("Last tick 2026-11-21 10:00 UTC");
    expect(html).not.toContain("no access");
  });

  it("shows nothing misleading on a complete snapshot with unset fields", () => {
    const html = renderInstallationSyncStatus({
      complete: true,
      syncedAt: "2026-11-21T10:00:00.000Z",
      reposSeen: 2,
      totalCount: 2,
    });
    expect(html).toContain("Synced 2026-11-21 10:00 UTC");
    expect(html).toContain("2 of 2 repos");
    expect(html).not.toMatch(/attempt|Refreshing|Last tick|error/i);
  });

  it("singularizes one attempt and ignores zero attempts", () => {
    expect(
      renderInstallationSyncStatus({ complete: true, attempts: 1 }),
    ).toContain("1 failed attempt<");
    expect(
      renderInstallationSyncStatus({ complete: true, attempts: 0 }),
    ).not.toContain("attempt");
  });

  it("renders nothing for an older API with no detail", () => {
    expect(renderInstallationSyncStatus({})).toBe("");
  });
});
