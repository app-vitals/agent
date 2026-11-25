/**
 * admin/src/github-sync-switch.unit.test.ts
 * GIS-1.2: Sync switches "all" installations to "selected". Pure planning
 * (planGithubSync / planSelectionSwitches) and the service apply order over
 * in-memory ports and a cache port. The existing selected-org tests in
 * github-sync.unit.test.ts stay as the regression guard.
 */

import { describe, expect, it } from "bun:test";
import {
  EMPTY_SWITCH_TARGET_REASON,
  GithubSyncService,
  MAX_SELECTION_PATCH_REPOS,
  planGithubSync,
  planSelectionSwitches,
  STILL_PUSHABLE_REASON,
  SWITCH_PERMISSION_MESSAGE,
} from "./github-sync.ts";
import type {
  InstallationAuditEntry,
  AppIdentity,
} from "./installation-ports.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";
import type { UserRepoAccessResult } from "./user-repo-access-resolver.ts";

type Sel = "all" | "selected" | null;

const accessFor = (
  pushable: string[],
  all: string[],
): UserRepoAccessResult => ({
  username: "octo",
  outcome: "ok",
  userVerified: true,
  orgs: [
    {
      org: "acme",
      status: "ok",
      unresolved: 0,
      repos: all.map((fullName) => ({
        fullName,
        canPush: pushable.includes(fullName),
        level: pushable.includes(fullName) ? ("write" as const) : ("read" as const),
      })),
    },
  ],
  unresolved: 0,
  complete: true,
  checkedAt: "2026-11-25T00:00:00.000Z",
});

const INSTALLED = ["acme/a", "acme/b", "acme/c"];
const plan = (
  selection: Sel | undefined,
  over: {
    pushable?: string[];
    installed?: string[];
    requested?: { appAdds: string[]; appRemoves: string[]; agentRemoves: string[] };
  } = {},
) => {
  const installed = over.installed ?? INSTALLED;
  return planGithubSync({
    username: "octo",
    access: accessFor(over.pushable ?? ["acme/a"], installed),
    agentRepos: [],
    installationRepos: { acme: installed },
    ...(selection === undefined ? {} : { selections: { acme: selection } }),
    ...(over.requested ? { requested: over.requested } : {}),
  });
};

describe("planGithubSync selection switches", () => {
  it("an 'all' org switches to installed minus the removes; removes still count", () => {
    const p = plan("all");
    expect(p.selectionSwitches).toEqual([{ org: "acme", repos: ["acme/a"] }]);
    expect(p.appRemoves).toEqual(["acme/b", "acme/c"]);
    expect(p.removedRepos).toEqual(["acme/b", "acme/c"]);
  });

  it("a 'selected' org has no switch", () => {
    const p = plan("selected");
    expect(p.selectionSwitches).toEqual([]);
    expect(p.appRemoves).toEqual(["acme/b", "acme/c"]);
  });

  it("null or missing selection is never treated as 'all'", () => {
    expect(plan(null).selectionSwitches).toEqual([]);
    expect(plan(undefined).selectionSwitches).toEqual([]);
  });

  it("matches the selection key case-insensitively", () => {
    const p = planGithubSync({
      username: "octo",
      access: accessFor(["acme/a"], INSTALLED),
      agentRepos: [],
      installationRepos: { acme: INSTALLED },
      selections: { ACME: "all" },
    });
    expect(p.selectionSwitches).toHaveLength(1);
  });

  it("an empty target skips the org with a warning pointing to Uninstall and drops its removes", () => {
    const p = plan("all", { pushable: [] });
    expect(p.selectionSwitches).toEqual([]);
    expect(p.skippedOrgs).toEqual([
      { org: "acme", reason: EMPTY_SWITCH_TARGET_REASON },
    ]);
    expect(p.warnings.join()).toContain("Uninstall");
    expect(p.appRemoves).toEqual([]);
    expect(p.removedRepos).toEqual([]);
  });

  it("an empty target with a requested list reports the dropped removes as not applied", () => {
    const p = plan("all", {
      pushable: [],
      requested: { appAdds: [], appRemoves: INSTALLED, agentRemoves: [] },
    });
    expect(p.notApplied.map((n) => n.repo)).toEqual(INSTALLED);
    expect(p.notApplied[0]?.reason).toBe(EMPTY_SWITCH_TARGET_REASON);
  });

  it("lists more than 50 repos in full (the apply splits them)", () => {
    const many = Array.from({ length: 60 }, (_, i) => `acme/r${String(i).padStart(2, "0")}`);
    const p = plan("all", { installed: many, pushable: many });
    expect(p.selectionSwitches?.[0]?.repos).toHaveLength(60);
  });

  it("an org whose access was not usable is not switched", () => {
    const p = planGithubSync({
      username: "octo",
      access: { ...accessFor([], []), orgs: [] },
      agentRepos: [],
      installationRepos: { acme: INSTALLED },
      selections: { acme: "all" },
    });
    expect(p.selectionSwitches).toEqual([]);
  });

  it("planSelectionSwitches ignores ineligible orgs", () => {
    expect(
      planSelectionSwitches({
        installationRepos: { acme: ["acme/a"] },
        selections: { acme: "all" },
        appRemoves: [],
        eligible: () => false,
      }),
    ).toEqual({ switches: [], emptyOrgs: [] });
  });
});

// ─── service apply ───────────────────────────────────────────────────────────

const NOW = new Date("2026-11-25T12:00:00.000Z");

function harness(opts: {
  selection?: Sel;
  installed?: string[];
  pushable?: string[];
  /** verifyPush answer per repo; default: definitively false for non-pushable. */
  verify?: (repo: string) => boolean | undefined;
  switchError?: unknown;
  addError?: boolean;
  noSwitchPort?: boolean;
  agentRepos?: string[];
}) {
  const installed = opts.installed ?? INSTALLED;
  const pushable = opts.pushable ?? ["acme/a"];
  const calls: unknown[][] = [];
  const audits: InstallationAuditEntry[] = [];
  const port: InstallationReposPort = {
    listRepos: async () => ({ acme: installed }),
    listInstalled: async () => ({
      status: "found",
      orgs: [{ org: "acme", repos: installed }],
    }),
    addRepos: async (_a, org, repos) => {
      calls.push(["addRepos", org, [...repos]]);
      if (opts.addError) throw new Error("add failed");
    },
    removeRepos: async (_a, org, repos) => {
      calls.push(["removeRepos", org, [...repos]]);
    },
    ...(opts.noSwitchPort
      ? {}
      : {
          setRepositorySelection: async (
            _a: number,
            org: string,
            repos: readonly string[],
            _id?: AppIdentity,
          ) => {
            calls.push(["switch", org, [...repos]]);
            if (opts.switchError) throw opts.switchError;
          },
        }),
  };
  const openWork: OpenWorkPort = {
    listOpenWork: async () => [{ id: "T-1", repo: "acme/b", title: "x" }],
    blockOpenWork: async (...a) => {
      calls.push(["block", ...a]);
    },
  };
  const svc = new GithubSyncService({
    agents: {
      get: async () => ({
        id: "ag",
        githubUsername: "octo",
        appId: 7,
        repos: opts.agentRepos ?? (installed.includes("acme/b") ? ["acme/b"] : []),
      }),
      setRepos: async (_id, repos) => {
        calls.push(["setRepos", [...repos]]);
      },
    },
    access: async () => {
      throw new Error("live resolver must not be used");
    },
    cache: {
      listAgentSnapshots: async () => [
        {
          org: "acme",
          completedAt: new Date(NOW.getTime() - 1000),
          totalCount: installed.length,
          lastError: null,
          rateLimitResetAt: null,
          repositorySelection: opts.selection ?? null,
          repos: installed.map((fullName) => ({ fullName })),
        },
      ],
      getAccessRows: async () =>
        installed.map((f) => ({
          repo: f.split("/")[1] as string,
          status: "ok",
          canPush: pushable.includes(f),
          checkedAt: new Date(NOW.getTime() - 1000),
        })),
    },
    lookupRepos: async () => [
      {
        org: "acme",
        completedAt: new Date(NOW.getTime() - 1000),
        repos: installed,
      },
    ],
    now: () => NOW,
    verifyPush: async (_u, repo) =>
      opts.verify ? opts.verify(repo) : pushable.includes(repo),
    installation: port,
    audit: {
      write: async (e) => {
        calls.push(["audit"]);
        audits.push(e);
        return `audit-${audits.length}`;
      },
    },
    openWork,
  });
  return { svc, calls, audits };
}

const apply = (
  svc: GithubSyncService,
  lists: { appAdds?: string[]; appRemoves?: string[]; agentRemoves?: string[] } = {},
  confirmRemovals?: boolean,
) =>
  svc.apply({
    agentId: "ag",
    caller: "root",
    appAdds: [],
    appRemoves: ["acme/b", "acme/c"],
    agentRemoves: ["acme/b"],
    ...lists,
    ...(confirmRemovals === undefined ? {} : { confirmRemovals }),
  });

describe("GithubSyncService selection switch", () => {
  it("previews the switch for an 'all' org read from the cache", async () => {
    const { svc, calls } = harness({ selection: "all" });
    const r = await svc.preview("ag");
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.selectionSwitches).toEqual([
      { org: "acme", repos: ["acme/a"] },
    ]);
    expect(calls).toEqual([]);
  });

  it("applies switches, adds, removes, agent repos, audit, open work in that order, folding the removes", async () => {
    const { svc, calls, audits } = harness({ selection: "all" });
    const r = await apply(svc);
    expect(r.status).toBe("applied");
    expect(calls.map((c) => c[0])).toEqual([
      "switch",
      "setRepos",
      "audit",
      "block",
      "block",
    ]);
    expect(calls[0]).toEqual(["switch", "acme", ["acme/a"]]);
    expect(audits[0]?.diff).toMatchObject({
      installationAdds: [],
      installationRemoves: ["acme/b", "acme/c"],
      selectionSwitches: [{ org: "acme", repos: ["acme/a"] }],
    });
    expect(audits[0]?.result).toEqual({ status: "applied" });
    // open work is blocked for the removed repos, including the folded ones
    expect(JSON.stringify(calls.filter((c) => c[0] === "block"))).toContain(
      "acme/b",
    );
  });

  it("a 'selected' org still removes the usual way and records no switch", async () => {
    const { svc, calls, audits } = harness({ selection: "selected" });
    await apply(svc);
    expect(calls.map((c) => c[0])).toEqual(["removeRepos", "setRepos", "audit", "block", "block"]);
    expect(audits[0]?.diff.selectionSwitches).toBeUndefined();
  });

  it("an unknown selection triggers no switch", async () => {
    const { svc, calls } = harness({ selection: null });
    await apply(svc);
    expect(calls.some((c) => c[0] === "switch")).toBe(false);
  });

  it("switch removals still count toward the >10 cap", async () => {
    const installed = Array.from({ length: 12 }, (_, i) => `acme/r${i}`);
    const { svc, calls } = harness({
      selection: "all",
      installed: [...installed, "acme/keep"],
      pushable: ["acme/keep"],
    });
    const r = await apply(svc, { appRemoves: installed, agentRemoves: [] });
    expect(r.status).toBe("removal_cap");
    expect(calls).toEqual([]);
    const ok = await apply(svc, { appRemoves: installed, agentRemoves: [] }, true);
    expect(ok.status).toBe("applied");
    expect(calls[0]).toEqual(["switch", "acme", ["acme/keep"]]);
  });

  it("a re-verified removal the user can still push to stays in the target", async () => {
    const { svc, calls } = harness({
      selection: "all",
      verify: (repo) => repo === "acme/c",
    });
    const r = await apply(svc);
    if (r.status !== "applied") throw new Error(r.status);
    expect(r.plan.notApplied).toContainEqual({
      repo: "acme/c",
      reason: STILL_PUSHABLE_REASON,
    });
    expect(r.plan.removedRepos).toEqual(["acme/b"]);
    expect(calls[0]).toEqual(["switch", "acme", ["acme/a", "acme/c"]]);
  });

  it("a switch-only change is not a noop", async () => {
    const { svc } = harness({ selection: "all", pushable: INSTALLED });
    const r = await apply(svc, { appRemoves: [], agentRemoves: [] });
    expect(r.status).toBe("applied");
  });

  it("an empty target is skipped, left on 'all', with a warning", async () => {
    const { svc, calls } = harness({ selection: "all", pushable: [] });
    const r = await apply(svc, {
      appRemoves: INSTALLED,
      agentRemoves: [],
    });
    expect(r.status).toBe("noop");
    expect(calls).toEqual([]);
    if (r.status !== "noop") return;
    expect(r.plan.skippedOrgs[0]?.reason).toBe(EMPTY_SWITCH_TARGET_REASON);
  });

  it("sends the first 50 in the PATCH and the rest through the batched add", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `acme/r${String(i).padStart(3, "0")}`);
    const { svc, calls, audits } = harness({
      selection: "all",
      installed: many,
      pushable: many,
      agentRepos: [],
    });
    const r = await apply(svc, { appRemoves: [], agentRemoves: [] });
    expect(r.status).toBe("applied");
    const sw = calls[0] as [string, string, string[]];
    expect(sw[2]).toHaveLength(MAX_SELECTION_PATCH_REPOS);
    expect(calls[1]).toEqual(["addRepos", "acme", many.slice(50)]);
    expect(audits[0]?.diff.selectionSwitches?.[0]?.repos).toEqual([...many].sort());
  });

  it("a failed add after the PATCH records only the repos that landed", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `acme/r${String(i).padStart(2, "0")}`);
    const { svc, audits } = harness({
      selection: "all",
      installed: many,
      pushable: many,
      agentRepos: [],
      addError: true,
    });
    const r = await apply(svc, { appRemoves: [], agentRemoves: [] });
    expect(r.status).toBe("failed");
    expect(audits[0]?.result.status).toBe("failed");
    expect(audits[0]?.diff.selectionSwitches?.[0]?.repos).toHaveLength(50);
  });

  it("maps a 403 on the switch to the missing-permission message and a failed audit with nothing landed", async () => {
    const err = Object.assign(new Error("Resource not accessible"), {
      kind: "permission",
      status: 403,
    });
    const { svc, calls, audits } = harness({ selection: "all", switchError: err });
    const r = await apply(svc);
    if (r.status !== "failed") throw new Error(r.status);
    expect(r.error).toBe(SWITCH_PERMISSION_MESSAGE("acme"));
    expect(r.error).toContain("enterprise_organization_installation_repositories");
    expect(audits[0]?.result).toEqual({ status: "failed", error: r.error });
    expect(audits[0]?.diff).toEqual({
      installationAdds: [],
      installationRemoves: [],
      configAdds: [],
      configRemoves: [],
    });
    expect(calls.map((c) => c[0])).toEqual(["switch", "audit"]);
  });

  it("fails clearly when the port cannot switch", async () => {
    const { svc } = harness({ selection: "all", noSwitchPort: true });
    const r = await apply(svc);
    if (r.status !== "failed") throw new Error(r.status);
    expect(r.error).toContain("cannot switch acme");
  });
});
