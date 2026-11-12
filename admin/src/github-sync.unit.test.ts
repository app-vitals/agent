import { describe, expect, it, test } from "bun:test";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import {
  GITHUB_SYNC_AUDIT_PLAN_HASH,
  GithubSyncService,
  NOT_ADDABLE_REASON,
  NOT_PRESENT_REASON,
  planGithubSync,
  STILL_PUSHABLE_REASON,
  type GithubSyncPlanInput,
} from "./github-sync.ts";
import type {
  InstallationAgentRecord,
  InstallationAuditEntry,
} from "./installation-ports.ts";
import {
  type InstallationReposPort,
  NO_INSTALLATION_REASON,
} from "./installation-repos-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";
import { repoLostAccessBlockReason } from "./repo-removal-open-work.ts";
import {
  type OrgAccessResult,
  SELECTED_REPOS_REASON,
  type UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

const repo = (fullName: string, canPush: boolean) => ({
  fullName,
  canPush,
  level: canPush ? ("write" as const) : ("read" as const),
});

const org = (
  name: string,
  repos: ReturnType<typeof repo>[],
  extra: Partial<OrgAccessResult> = {},
): OrgAccessResult => ({
  org: name,
  status: "ok",
  repos,
  unresolved: 0,
  ...extra,
});

const access = (
  orgs: OrgAccessResult[],
  extra: Partial<UserRepoAccessResult> = {},
): UserRepoAccessResult => ({
  username: "octo",
  outcome: "ok",
  userVerified: true,
  orgs,
  unresolved: 0,
  complete: orgs.every((o) => o.status === "ok"),
  checkedAt: "2026-11-11T00:00:00.000Z",
  ...extra,
});

// The user can push to a, d, e; not to b, c.
const ACME = org("acme", [
  repo("acme/a", true),
  repo("acme/b", false),
  repo("acme/c", false),
  repo("acme/d", true),
  repo("acme/e", true),
]);

const base = (
  over: Partial<GithubSyncPlanInput> = {},
): GithubSyncPlanInput => ({
  username: "octo",
  access: access([ACME]),
  agentRepos: ["acme/a", "acme/b"],
  installationRepos: { acme: ["acme/a", "acme/b", "acme/c"] },
  ...over,
});

describe("planGithubSync (preview)", () => {
  test("lists app adds, app removes and agent removes", () => {
    const p = planGithubSync(base());
    expect(p.skipped).toBe(false);
    expect(p.appAdds).toEqual(["acme/d", "acme/e"]);
    expect(p.appRemoves).toEqual(["acme/b", "acme/c"]);
    expect(p.agentRemoves).toEqual(["acme/b"]);
    expect(p.removedRepos).toEqual(["acme/b", "acme/c"]);
  });

  test("agent repos are never added", () => {
    const p = planGithubSync(base({ agentRepos: [] }));
    expect(p.appAdds).toEqual(["acme/d", "acme/e"]);
    expect(p.agentRemoves).toEqual([]);
    expect("agentAdds" in p).toBe(false);
  });

  test("adds have no cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => repo(`acme/n${i}`, true));
    const p = planGithubSync(
      base({
        access: access([org("acme", many)]),
        agentRepos: [],
        installationRepos: { acme: [] },
      }),
    );
    expect(p.appAdds).toHaveLength(40);
  });

  test("nothing to do once the lists are applied", () => {
    const p = planGithubSync(
      base({
        agentRepos: ["acme/a"],
        installationRepos: { acme: ["acme/a", "acme/d", "acme/e"] },
      }),
    );
    expect([p.appAdds, p.appRemoves, p.agentRemoves]).toEqual([[], [], []]);
  });

  test("push checks and installed lookups ignore case", () => {
    const p = planGithubSync(
      base({ agentRepos: ["ACME/A"], installationRepos: { acme: ["Acme/a"] } }),
    );
    expect(p.appRemoves).toEqual([]);
    expect(p.agentRemoves).toEqual([]);
    expect(p.appAdds).not.toContain("acme/a");
  });

  test("a repo missing from a complete org listing counts as no access", () => {
    const p = planGithubSync(
      base({ agentRepos: ["acme/gone"], installationRepos: { acme: [] } }),
    );
    expect(p.agentRemoves).toEqual(["acme/gone"]);
  });

  test("orgs without the agent App installed get no adds", () => {
    const p = planGithubSync(
      base({
        access: access([ACME, org("other", [repo("other/x", true)])]),
        installationRepos: { acme: [] },
      }),
    );
    expect(p.appAdds.every((r) => r.startsWith("acme/"))).toBe(true);
    expect(p.appAdds).not.toContain("other/x");
  });

  test.each([
    ["partial", { status: "partial" as const, unresolved: 1 }],
    ["failed", { status: "rate_limited" as const }],
    ["not installed", { status: "lookup_app_not_installed" as const }],
    [
      "selected-only",
      { status: "error" as const, reason: SELECTED_REPOS_REASON },
    ],
  ])("skips a %s org for adds and removes and reports it", (_l, extra) => {
    const p = planGithubSync(
      base({
        access: access([
          org("acme", [repo("acme/d", true), repo("acme/b", false)], extra),
        ]),
      }),
    );
    expect([p.appAdds, p.appRemoves, p.agentRemoves]).toEqual([[], [], []]);
    expect(p.skippedOrgs).toHaveLength(1);
    expect(p.skippedOrgs[0]?.org).toBe("acme");
    expect(p.warnings[0]).toContain("acme");
  });

  test("an org missing from the access result is skipped, not emptied", () => {
    const p = planGithubSync(
      base({
        agentRepos: ["other/x"],
        installationRepos: { other: ["other/x"] },
        access: access([]),
      }),
    );
    expect(p.appRemoves).toEqual([]);
    expect(p.agentRemoves).toEqual([]);
    expect(p.skippedOrgs).toEqual([
      { org: "other", reason: "org was not checked" },
    ]);
  });

  test.each([
    ["unbound", { username: "  " }, "no GitHub username"],
    [
      "not found",
      { access: access([ACME], { outcome: "user_not_found" }) },
      "not found",
    ],
    [
      "unverified",
      { access: access([ACME], { userVerified: false }) },
      "verified",
    ],
    ["unresolved", { access: null }, "not resolved"],
  ])("a %s user skips the whole plan", (_l, over, reason) => {
    const p = planGithubSync(base(over as Partial<GithubSyncPlanInput>));
    expect(p.skipped).toBe(true);
    expect(p.skipReason).toContain(reason);
    expect([p.appAdds, p.appRemoves, p.agentRemoves]).toEqual([[], [], []]);
  });
});

describe("planGithubSync (confirmed lists)", () => {
  it("re-checks every confirmed repo and reports the ones left alone", () => {
    const p = planGithubSync(
      base({
        agentRepos: ["acme/a", "acme/b", "other/x"],
        requested: {
          appAdds: ["acme/d", "acme/b", "acme/c", "other/y"],
          appRemoves: ["acme/b", "acme/a", "acme/zzz"],
          agentRemoves: ["acme/b", "acme/a", "other/x"],
        },
      }),
    );
    expect(p.appAdds).toEqual(["acme/d"]);
    expect(p.appRemoves).toEqual(["acme/b"]);
    expect(p.agentRemoves).toEqual(["acme/b"]);
    expect(p.notApplied).toContainEqual({
      repo: "acme/b",
      reason: NOT_ADDABLE_REASON,
    });
    expect(p.notApplied).toContainEqual({
      repo: "acme/a",
      reason: STILL_PUSHABLE_REASON,
    });
    expect(p.notApplied).toContainEqual({
      repo: "acme/zzz",
      reason: NOT_PRESENT_REASON,
    });
    expect(p.notApplied).toContainEqual({
      repo: "other/x",
      reason: "skipped for org: org was not checked",
    });
  });

  it("a confirmed add is never applied to the agent's repos", () => {
    const p = planGithubSync(
      base({
        agentRepos: [],
        requested: { appAdds: ["acme/d"], appRemoves: [], agentRemoves: [] },
      }),
    );
    expect(p.appAdds).toEqual(["acme/d"]);
    expect(p.agentRemoves).toEqual([]);
  });
});

// ─── Service ────────────────────────────────────────────────────────────────

function harness(
  opts: {
    agent?: Partial<InstallationAgentRecord> | null;
    access?: Awaited<ReturnType<GithubAccessPreviewFn>>;
    installed?: { org: string; repos: string[] }[];
    noInstallation?: boolean;
    removeFails?: boolean;
    openWork?: Partial<OpenWorkPort> | null;
  } = {},
) {
  const calls: unknown[][] = [];
  const audits: InstallationAuditEntry[] = [];
  let repos = opts.agent?.repos ?? ["acme/a", "acme/b"];
  let installed = opts.installed ?? [
    { org: "acme", repos: ["acme/a", "acme/b", "acme/c"] },
  ];
  const agent: InstallationAgentRecord | null =
    opts.agent === null
      ? null
      : { id: "ag", githubUsername: "octo", appId: 7, ...opts.agent, repos };
  const installation: Pick<
    InstallationReposPort,
    "listInstalled" | "addRepos" | "removeRepos"
  > = {
    listInstalled: async (appId) => {
      calls.push(["listInstalled", appId]);
      return opts.noInstallation
        ? { status: "none" }
        : { status: "found", orgs: installed };
    },
    addRepos: async (appId, o, r) => {
      calls.push(["addRepos", appId, o, [...r]]);
      installed = installed.map((i) =>
        i.org === o ? { ...i, repos: [...i.repos, ...r] } : i,
      );
    },
    removeRepos: async (appId, o, r) => {
      calls.push(["removeRepos", appId, o, [...r]]);
      if (opts.removeFails) throw new Error("github says no");
      installed = installed.map((i) =>
        i.org === o
          ? { ...i, repos: i.repos.filter((x) => !r.includes(x)) }
          : i,
      );
    },
  };
  const openWork: OpenWorkPort | undefined =
    opts.openWork === null
      ? undefined
      : {
          listOpenWork: async (...a) => {
            calls.push(["list", ...a]);
            return [{ id: "T-1", repo: "acme/b", title: "fix" }];
          },
          blockOpenWork: async (...a) => {
            calls.push(["block", ...a]);
          },
          ...opts.openWork,
        };
  const svc = new GithubSyncService({
    agents: {
      get: async () => (agent ? { ...agent, repos } : null),
      setRepos: async (_id, next) => {
        calls.push(["setRepos", [...next]]);
        repos = next;
      },
    },
    access: async () => opts.access ?? { status: "ok", access: access([ACME]) },
    installation,
    audit: {
      write: async (e) => {
        calls.push(["audit"]);
        audits.push(e);
        return `audit-${audits.length}`;
      },
    },
    ...(openWork ? { openWork } : {}),
  });
  return { svc, calls, audits, repos: () => repos };
}

const applyInput = (
  lists: {
    appAdds?: string[];
    appRemoves?: string[];
    agentRemoves?: string[];
  },
  extra = {},
) => ({
  agentId: "ag",
  caller: "root",
  appAdds: [],
  appRemoves: [],
  agentRemoves: [],
  ...lists,
  ...extra,
});

describe("GithubSyncService with no installation", () => {
  it("preview is skipped with the no-installation reason", async () => {
    const { svc } = harness({ noInstallation: true });
    expect(await svc.preview("ag")).toEqual({
      status: "skipped",
      reason: NO_INSTALLATION_REASON,
    });
  });

  it("apply is skipped, not noop, and changes nothing", async () => {
    const { svc, calls, audits } = harness({ noInstallation: true });
    expect(await svc.apply(applyInput({}))).toEqual({
      status: "skipped",
      reason: NO_INSTALLATION_REASON,
    });
    expect(calls.map((c) => c[0])).toEqual(["listInstalled"]);
    expect(audits).toEqual([]);
  });

  it("an App matched to an org with nothing to change still returns noop", async () => {
    const { svc } = harness({
      installed: [{ org: "acme", repos: ["acme/a", "acme/b"] }],
    });
    expect((await svc.apply(applyInput({}))).status).toBe("noop");
  });
});

describe("GithubSyncService.preview", () => {
  it("returns all three lists plus the open work removals block, changing nothing", async () => {
    const { svc, calls, audits } = harness();
    const r = await svc.preview("ag");
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.appAdds).toEqual(["acme/d", "acme/e"]);
    expect(r.plan.appRemoves).toEqual(["acme/b", "acme/c"]);
    expect(r.plan.agentRemoves).toEqual(["acme/b"]);
    expect(r.openWork).toEqual([{ id: "T-1", repo: "acme/b", title: "fix" }]);
    expect(calls).toEqual([
      ["listInstalled", 7],
      ["list", "ag", ["acme/b", "acme/c"]],
    ]);
    expect(audits).toEqual([]);
  });

  it("a failing open-work port is a warning", async () => {
    const { svc } = harness({
      openWork: {
        listOpenWork: async () => {
          throw new Error("store down");
        },
      },
    });
    const r = await svc.preview("ag");
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.openWork).toEqual([]);
    expect(r.warnings.join()).toContain("store down");
  });

  it("is skipped for an unbound user with no GitHub calls", async () => {
    const { svc, calls } = harness({ agent: { githubUsername: null } });
    expect(await svc.preview("ag")).toMatchObject({ status: "skipped" });
    expect(calls).toEqual([]);
  });

  it("is skipped for unconfigured Apps and for a missing GH_APP_ID", async () => {
    expect(
      await harness({ access: { status: "unconfigured" } }).svc.preview("ag"),
    ).toEqual({ status: "skipped", reason: "GitHub Apps are not configured" });
    const noApp = await harness({ agent: { appId: undefined } }).svc.preview(
      "ag",
    );
    expect(JSON.stringify(noApp)).toContain("GH_APP_ID");
  });

  it("agent_not_found for an unknown agent", async () => {
    expect(await harness({ agent: null }).svc.preview("ag")).toEqual({
      status: "agent_not_found",
    });
  });
});

describe("GithubSyncService.apply", () => {
  it("adds, removes, removes agent repos, audits once, then blocks open work", async () => {
    const { svc, calls, audits, repos } = harness();
    const r = await svc.apply(
      applyInput({
        appAdds: ["acme/d"],
        appRemoves: ["acme/b", "acme/c"],
        agentRemoves: ["acme/b"],
      }),
    );
    expect(r).toMatchObject({
      status: "applied",
      auditId: "audit-1",
      warnings: [],
    });
    expect(calls).toEqual([
      ["listInstalled", 7],
      ["addRepos", 7, "acme", ["acme/d"]],
      ["removeRepos", 7, "acme", ["acme/b", "acme/c"]],
      ["setRepos", ["acme/a"]],
      ["audit"],
      ["block", "ag", ["acme/b"], repoLostAccessBlockReason("acme/b")],
      ["block", "ag", ["acme/c"], repoLostAccessBlockReason("acme/c")],
    ]);
    expect(repos()).toEqual(["acme/a"]);
    expect(audits).toEqual([
      {
        agentId: "ag",
        caller: "root",
        planHash: GITHUB_SYNC_AUDIT_PLAN_HASH,
        diff: {
          installationAdds: ["acme/d"],
          installationRemoves: ["acme/b", "acme/c"],
          configAdds: [],
          configRemoves: ["acme/b"],
        },
        result: { status: "applied" },
      },
    ]);
    // A second preview has nothing left to do.
    const again = await svc.preview("ag");
    if (again.status !== "previewed") throw new Error(again.status);
    expect(again.plan.appRemoves).toEqual([]);
    expect(again.plan.agentRemoves).toEqual([]);
    expect(again.plan.appAdds).toEqual(["acme/e"]);
  });

  it("leaves confirmed repos that no longer qualify alone and reports them", async () => {
    const { svc } = harness();
    const r = await svc.apply(
      applyInput({ appRemoves: ["acme/a", "acme/b"], appAdds: ["acme/b"] }),
    );
    if (r.status !== "applied") throw new Error(r.status);
    expect(r.plan.appRemoves).toEqual(["acme/b"]);
    expect(r.plan.notApplied.map((n) => n.repo).sort()).toEqual([
      "acme/a",
      "acme/b",
    ]);
  });

  it("noop with no audit when nothing confirmed still applies", async () => {
    const { svc, calls, audits } = harness();
    const r = await svc.apply(applyInput({ appRemoves: ["acme/a"] }));
    expect(r.status).toBe("noop");
    expect(audits).toEqual([]);
    expect(calls.map((c) => c[0])).toEqual(["listInstalled"]);
  });

  it("a skipped call changes nothing and writes no audit row", async () => {
    for (const h of [
      harness({ agent: { githubUsername: null } }),
      harness({
        access: {
          status: "ok",
          access: access([ACME], { userVerified: false }),
        },
      }),
      harness({
        access: {
          status: "user_not_found",
          access: access([], { outcome: "user_not_found" }),
        },
      }),
    ]) {
      const r = await h.svc.apply(applyInput({ appRemoves: ["acme/b"] }));
      expect(r.status).toBe("skipped");
      expect(h.audits).toEqual([]);
      expect(h.calls.filter((c) => c[0] !== "listInstalled")).toEqual([]);
    }
  });

  it("skipped orgs get neither adds nor removes", async () => {
    const { svc, audits } = harness({
      access: {
        status: "ok",
        access: access([
          org("acme", [repo("acme/d", true)], {
            reason: SELECTED_REPOS_REASON,
            status: "error",
          }),
        ]),
      },
    });
    const r = await svc.apply(
      applyInput({ appAdds: ["acme/d"], appRemoves: ["acme/b"] }),
    );
    if (r.status !== "noop") throw new Error(r.status);
    expect(r.plan.skippedOrgs[0]?.org).toBe("acme");
    expect(audits).toEqual([]);
  });

  it("more than 10 removals need confirmRemovals; adds do not count", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
    const h = harness({
      agent: { repos: many },
      installed: [{ org: "acme", repos: many }],
    });
    const lists = { appRemoves: many, agentRemoves: many, appAdds: ["acme/d"] };
    const r = await h.svc.apply(applyInput(lists));
    expect(r).toMatchObject({ status: "removal_cap", removals: 11 });
    expect(h.audits).toEqual([]);
    expect(h.repos()).toEqual(many);
    const ok = await h.svc.apply(applyInput(lists, { confirmRemovals: true }));
    expect(ok.status).toBe("applied");
    expect(h.repos()).toEqual([]);
  });

  it("an open-work port failure is a warning, not a failed call", async () => {
    const { svc, audits } = harness({
      openWork: {
        blockOpenWork: async () => {
          throw new Error("store down");
        },
      },
    });
    const r = await svc.apply(applyInput({ agentRemoves: ["acme/b"] }));
    if (r.status !== "applied") throw new Error(r.status);
    expect(r.warnings[0]).toContain("acme/b");
    expect(r.warnings[0]).toContain("store down");
    expect(audits).toHaveLength(1);
  });

  it("works without an open-work port", async () => {
    const r = await harness({ openWork: null }).svc.apply(
      applyInput({ agentRemoves: ["acme/b"] }),
    );
    expect(r).toMatchObject({ status: "applied", warnings: [] });
  });

  it("a GitHub failure writes a failed audit with only what landed and blocks nothing", async () => {
    const { svc, calls, audits, repos } = harness({ removeFails: true });
    const r = await svc.apply(
      applyInput({
        appAdds: ["acme/d"],
        appRemoves: ["acme/b"],
        agentRemoves: ["acme/b"],
      }),
    );
    expect(r).toMatchObject({ status: "failed", auditId: "audit-1" });
    expect(repos()).toEqual(["acme/a", "acme/b"]);
    expect(audits[0]?.result).toEqual({
      status: "failed",
      error: "github says no",
    });
    expect(audits[0]?.diff.installationAdds).toEqual(["acme/d"]);
    expect(audits[0]?.diff.installationRemoves).toEqual([]);
    expect(audits[0]?.diff.configRemoves).toEqual([]);
    expect(calls.some((c) => c[0] === "block")).toBe(false);
  });

  it("removes an agent repo even when the App is not installed on its org", async () => {
    const { svc, calls, repos } = harness({ installed: [] });
    const r = await svc.apply(applyInput({ agentRemoves: ["acme/b"] }));
    expect(r.status).toBe("applied");
    expect(calls.some((c) => c[0] === "removeRepos")).toBe(false);
    expect(repos()).toEqual(["acme/a"]);
  });
});
