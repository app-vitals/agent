import { describe, expect, it, test } from "bun:test";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";
import {
  LOST_ACCESS_AUDIT_PLAN_HASH,
  type LostAccessPlanInput,
  LostAccessRemovalService,
  NOT_PRESENT_REASON,
  planLostAccessRemoval,
  STILL_PUSHABLE_REASON,
} from "./lost-access-removal.ts";
import type {
  InstallationAgentRecord,
  InstallationAuditEntry,
} from "./installation-ports.ts";
import type { OpenWorkPort } from "./open-work-port.ts";
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

const ACME = org("acme", [
  repo("acme/a", true),
  repo("acme/b", false),
  repo("acme/c", false),
]);

const base = (
  over: Partial<LostAccessPlanInput> = {},
): LostAccessPlanInput => ({
  username: "octo",
  access: access([ACME]),
  agentRepos: ["acme/a", "acme/b"],
  installationRepos: { acme: ["acme/a", "acme/b", "acme/c"] },
  ...over,
});

describe("planLostAccessRemoval", () => {
  test("removes repos the user cannot push to from installation and agent repos", () => {
    const p = planLostAccessRemoval(base());
    expect(p.skipped).toBe(false);
    expect(p.repos).toEqual(["acme/b", "acme/c"]);
    expect(p.installationRemoves).toEqual(["acme/b", "acme/c"]);
    expect(p.configRemoves).toEqual(["acme/b"]);
  });

  test("never adds: a pushable repo missing from the agent stays missing", () => {
    const p = planLostAccessRemoval(
      base({ agentRepos: [], installationRepos: { acme: ["acme/a"] } }),
    );
    expect(p.repos).toEqual([]);
    expect(p.configRemoves).toEqual([]);
  });

  test("a repo not listed in a complete org listing counts as no access", () => {
    const p = planLostAccessRemoval(
      base({ agentRepos: ["acme/gone"], installationRepos: {} }),
    );
    expect(p.configRemoves).toEqual(["acme/gone"]);
  });

  test("push checks ignore case", () => {
    const p = planLostAccessRemoval(
      base({ agentRepos: ["ACME/A"], installationRepos: { acme: ["Acme/a"] } }),
    );
    expect(p.repos).toEqual([]);
  });

  test.each([
    ["partial", { status: "partial" as const, unresolved: 1 }],
    ["failed", { status: "rate_limited" as const }],
    [
      "selected-only",
      { status: "error" as const, reason: SELECTED_REPOS_REASON },
    ],
  ])("skips a %s org and reports it", (_label, extra) => {
    const p = planLostAccessRemoval(
      base({ access: access([org("acme", [repo("acme/a", true)], extra)]) }),
    );
    expect(p.repos).toEqual([]);
    expect(p.skippedOrgs).toHaveLength(1);
    expect(p.skippedOrgs[0]?.org).toBe("acme");
    expect(p.warnings[0]).toContain("acme");
  });

  test("selected-only reason matches the shared access-rules wording", () => {
    const p = planLostAccessRemoval(
      base({
        access: access([org("acme", [], { reason: SELECTED_REPOS_REASON })]),
      }),
    );
    expect(p.skippedOrgs[0]?.reason).toContain("selected repositories");
  });

  test("an org missing from the access result is skipped, not emptied", () => {
    const p = planLostAccessRemoval(
      base({
        agentRepos: ["other/x"],
        installationRepos: { other: ["other/x"] },
      }),
    );
    expect(p.repos).toEqual([]);
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
    const p = planLostAccessRemoval(base(over as Partial<LostAccessPlanInput>));
    expect(p.skipped).toBe(true);
    expect(p.skipReason).toContain(reason);
    expect(p.repos).toEqual([]);
  });

  test("requested limits candidates and reports the ones left alone", () => {
    const p = planLostAccessRemoval(
      base({
        agentRepos: ["acme/a", "acme/b", "other/x"],
        requested: ["acme/a", "acme/b", "acme/zzz", "other/x"],
        installationRepos: { acme: ["acme/a", "acme/b", "acme/c"] },
      }),
    );
    expect(p.repos).toEqual(["acme/b"]);
    expect(p.installationRemoves).toEqual(["acme/b"]);
    expect(p.notRemoved).toEqual([
      { repo: "acme/a", reason: STILL_PUSHABLE_REASON },
      { repo: "acme/zzz", reason: NOT_PRESENT_REASON },
      {
        repo: "other/x",
        reason: "removals skipped for org: org was not checked",
      },
    ]);
  });
});

// ─── Service ────────────────────────────────────────────────────────────────

function harness(
  opts: {
    agent?: Partial<InstallationAgentRecord> | null;
    access?: Awaited<ReturnType<GithubAccessPreviewFn>>;
    installed?: { org: string; repos: string[] }[];
    removeFails?: boolean;
    openWork?: Partial<OpenWorkPort> | null;
  } = {},
) {
  const calls: unknown[][] = [];
  const audits: InstallationAuditEntry[] = [];
  let repos = opts.agent?.repos ?? ["acme/a", "acme/b"];
  const agent: InstallationAgentRecord | null =
    opts.agent === null
      ? null
      : {
          id: "ag",
          githubUsername: "octo",
          appId: 7,
          ...opts.agent,
          repos,
        };
  const installation: Pick<
    InstallationReposPort,
    "listInstalled" | "removeRepos"
  > = {
    listInstalled: async (appId) => {
      calls.push(["listInstalled", appId]);
      return (
        opts.installed ?? [
          { org: "acme", repos: ["acme/a", "acme/b", "acme/c"] },
        ]
      );
    },
    removeRepos: async (appId, o, r) => {
      calls.push(["removeRepos", appId, o, [...r]]);
      if (opts.removeFails) throw new Error("github says no");
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
  const svc = new LostAccessRemovalService({
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

const removeInput = (repos: string[], extra = {}) => ({
  agentId: "ag",
  caller: "root",
  repos,
  ...extra,
});

describe("LostAccessRemovalService.preview", () => {
  it("returns the repos that would be removed plus their open work, changing nothing", async () => {
    const { svc, calls, audits } = harness();
    const r = await svc.preview("ag");
    expect(r.status).toBe("previewed");
    if (r.status !== "previewed") return;
    expect(r.plan.repos).toEqual(["acme/b", "acme/c"]);
    expect(r.openWork).toEqual([{ id: "T-1", repo: "acme/b", title: "fix" }]);
    expect(calls.map((c) => c[0])).toEqual(["listInstalled", "list"]);
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
    expect(noApp).toMatchObject({ status: "skipped" });
    expect(JSON.stringify(noApp)).toContain("GH_APP_ID");
  });

  it("agent_not_found for an unknown agent", async () => {
    expect(await harness({ agent: null }).svc.preview("ag")).toEqual({
      status: "agent_not_found",
    });
  });
});

describe("LostAccessRemovalService.remove", () => {
  it("removes installation first, then agent repos, then audits, then blocks", async () => {
    const { svc, calls, audits, repos } = harness();
    const r = await svc.remove(removeInput(["acme/b", "acme/c"]));
    expect(r).toMatchObject({
      status: "applied",
      auditId: "audit-1",
      warnings: [],
    });
    expect(calls).toEqual([
      ["listInstalled", 7],
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
        planHash: LOST_ACCESS_AUDIT_PLAN_HASH,
        diff: {
          installationAdds: [],
          installationRemoves: ["acme/b", "acme/c"],
          configAdds: [],
          configRemoves: ["acme/b"],
        },
        result: { status: "applied" },
      },
    ]);
  });

  it("leaves a named repo the user can still push to alone and reports it", async () => {
    const { svc, repos } = harness();
    const r = await svc.remove(removeInput(["acme/a", "acme/b"]));
    if (r.status !== "applied") throw new Error(r.status);
    expect(r.plan.repos).toEqual(["acme/b"]);
    expect(r.plan.notRemoved).toEqual([
      { repo: "acme/a", reason: STILL_PUSHABLE_REASON },
    ]);
    expect(repos()).toEqual(["acme/a"]);
  });

  it("noop with no audit when nothing named still lacks access", async () => {
    const { svc, calls, audits } = harness();
    const r = await svc.remove(removeInput(["acme/a"]));
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
      const r = await h.svc.remove(removeInput(["acme/b"]));
      expect(r.status).toBe("skipped");
      expect(h.audits).toEqual([]);
      expect(h.calls.filter((c) => c[0] !== "listInstalled")).toEqual([]);
    }
  });

  it("skipped orgs are reported and nothing there is removed", async () => {
    const { svc, audits } = harness({
      access: {
        status: "ok",
        access: access([
          org("acme", [], { reason: SELECTED_REPOS_REASON, status: "error" }),
        ]),
      },
    });
    const r = await svc.remove(removeInput(["acme/b"]));
    expect(r.status).toBe("noop");
    if (r.status !== "noop") return;
    expect(r.plan.skippedOrgs[0]?.org).toBe("acme");
    expect(audits).toEqual([]);
  });

  it("more than 10 removals need confirmRemovals", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
    const h = harness({
      agent: { repos: many },
      installed: [{ org: "acme", repos: many }],
    });
    const r = await h.svc.remove(removeInput(many));
    expect(r).toMatchObject({ status: "removal_cap", removals: 11 });
    expect(h.audits).toEqual([]);
    expect(h.repos()).toEqual(many);
    const ok = await h.svc.remove(removeInput(many, { confirmRemovals: true }));
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
    const r = await svc.remove(removeInput(["acme/b"]));
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.warnings[0]).toContain("acme/b");
    expect(r.warnings[0]).toContain("store down");
    expect(audits).toHaveLength(1);
  });

  it("works without an open-work port", async () => {
    const r = await harness({ openWork: null }).svc.remove(
      removeInput(["acme/b"]),
    );
    expect(r).toMatchObject({ status: "applied", warnings: [] });
  });

  it("a GitHub failure writes a failed audit with only what landed and blocks nothing", async () => {
    const { svc, calls, audits, repos } = harness({ removeFails: true });
    const r = await svc.remove(removeInput(["acme/b"]));
    expect(r).toMatchObject({ status: "failed", auditId: "audit-1" });
    expect(repos()).toEqual(["acme/a", "acme/b"]);
    expect(audits[0]?.result).toEqual({
      status: "failed",
      error: "github says no",
    });
    expect(audits[0]?.diff.installationRemoves).toEqual([]);
    expect(audits[0]?.diff.configRemoves).toEqual([]);
    expect(calls.some((c) => c[0] === "block")).toBe(false);
  });

  it("removes an agent repo even when the App is not installed on its org", async () => {
    const { svc, calls, repos } = harness({ installed: [] });
    const r = await svc.remove(removeInput(["acme/b"]));
    expect(r.status).toBe("applied");
    expect(calls.some((c) => c[0] === "removeRepos")).toBe(false);
    expect(repos()).toEqual(["acme/a"]);
  });
});
