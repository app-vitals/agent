/**
 * admin/src/admin-ui-installation-repos-pages.unit.test.ts
 * Unit tests for the pure IRM-1.4 helpers and escaping.
 */

import { describe, expect, it } from "bun:test";
import {
  actuallyBlockedWork,
  APP_ID_MISMATCH_MESSAGE,
  NO_USERNAME_REASON,
  renderGithubSyncCard,
  renderInstallationReposBody,
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
