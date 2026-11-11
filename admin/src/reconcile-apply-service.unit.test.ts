/**
 * admin/src/reconcile-apply-service.unit.test.ts
 * Unit tests for the open-work port call and the apply guards (fakes only).
 */

import { describe, expect, it } from "bun:test";
import type { GithubAccessPreview } from "./github-access-preview.ts";
import {
  createInstallationPort,
  type ReconcileApplyDeps,
  ReconcileApplyService,
} from "./reconcile-apply-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";
import type { UserRepoAccessResult } from "./user-repo-access-resolver.ts";

function access(pushable: string[]): UserRepoAccessResult {
  return {
    username: "dev",
    outcome: "ok",
    userVerified: true,
    complete: true,
    unresolved: 0,
    checkedAt: "2026-11-11T00:00:00.000Z",
    orgs: [
      {
        org: "acme",
        status: "ok",
        unresolved: 0,
        repos: pushable.map((fullName) => ({
          fullName,
          level: "write" as const,
          canPush: true,
        })),
      },
    ],
  };
}

function build(opts: {
  appId?: number | null;
  repos: string[];
  pushable: string[];
  installed?: string[];
  openWork?: OpenWorkPort;
  preview?: GithubAccessPreview;
}) {
  const state = { repos: [...opts.repos] };
  const calls: string[] = [];
  const audits: unknown[] = [];
  const deps: ReconcileApplyDeps = {
    agents: {
      get: async () => ({
        id: "a1",
        repos: state.repos,
        githubUsername: "dev",
        ...(opts.appId === null ? {} : { appId: opts.appId ?? 42 }),
      }),
      setRepos: async (_id, repos) => {
        calls.push("config");
        state.repos = repos;
      },
    },
    access: async () =>
      opts.preview ?? { status: "ok", access: access(opts.pushable) },
    installation: {
      listRepos: async (_app, _orgs) => ({
        acme: opts.installed ?? opts.repos,
      }),
      addRepos: async (_app) => {
        calls.push("inst-add");
      },
      removeRepos: async () => {
        calls.push("inst-remove");
      },
    },
    audit: {
      write: async (e) => {
        audits.push(e);
        return "audit-1";
      },
    },
    openWork: opts.openWork,
  };
  return { svc: new ReconcileApplyService(deps), state, calls, audits };
}

describe("ReconcileApplyService (unit)", () => {
  it("calls blockOpenWork with the reconcile reason for each removed repo", async () => {
    const blocked: { repos: readonly string[]; reason: string }[] = [];
    const openWork: OpenWorkPort = {
      listOpenWork: async (_a, repos) =>
        repos.map((repo) => ({ id: `t-${repo}`, repo })),
      blockOpenWork: async (_a, repos, reason) => {
        blocked.push({ repos, reason });
      },
    };
    const { svc } = build({
      repos: ["acme/a", "acme/b"],
      pushable: ["acme/a"],
      openWork,
    });
    const plan = await svc.plan("a1");
    const res = await svc.apply({
      agentId: "a1",
      caller: "dan@x.io",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
    expect(blocked).toEqual([
      {
        repos: ["acme/b"],
        reason: "repo removed from agent by GitHub reconcile (acme/b)",
      },
    ]);
  });

  it("succeeds with no port and does not block", async () => {
    const { svc } = build({
      repos: ["acme/a", "acme/b"],
      pushable: ["acme/a"],
    });
    const plan = await svc.plan("a1");
    const res = await svc.apply({
      agentId: "a1",
      caller: "c",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
  });

  it("a port failure does not fail an applied reconcile", async () => {
    const openWork: OpenWorkPort = {
      listOpenWork: async () => [],
      blockOpenWork: async () => {
        throw new Error("store down");
      },
    };
    const { svc } = build({
      repos: ["acme/a", "acme/b"],
      pushable: ["acme/a"],
      openWork,
    });
    const plan = await svc.plan("a1");
    const res = await svc.apply({
      agentId: "a1",
      caller: "c",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
    expect(res.status === "applied" && res.warnings.join()).toContain(
      "store down",
    );
  });

  it("agent without GH_APP_ID is skipped with a reason naming GH_APP_ID", async () => {
    const { svc, calls } = build({
      appId: null,
      repos: ["acme/a"],
      pushable: ["acme/a"],
    });
    const plan = await svc.plan("a1");
    expect(plan.skipped).toBe(true);
    expect(plan.skipReason).toContain("GH_APP_ID");
    expect(plan.skipReason).not.toContain("not configured");
    const res = await svc.apply({ agentId: "a1", caller: "c", planHash: "x" });
    expect(res.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("passes the agent's own App id to the installation port", async () => {
    const seen: number[] = [];
    const { svc } = build({
      appId: 77,
      repos: ["acme/a"],
      pushable: ["acme/a"],
    });
    // @ts-expect-error reach into deps to spy
    const inst = svc.deps.installation;
    const orig = inst.listRepos;
    inst.listRepos = async (app: number, orgs: readonly string[]) => {
      seen.push(app);
      return orig(app, orgs);
    };
    await svc.plan("a1");
    expect(seen).toEqual([77]);
  });

  it("skipped plan (unconfigured) changes nothing and writes no audit", async () => {
    const { svc, calls, audits } = build({
      repos: ["acme/a"],
      pushable: [],
      preview: { status: "unconfigured" },
    });
    const res = await svc.apply({ agentId: "a1", caller: "c", planHash: "x" });
    expect(res.status).toBe("skipped");
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe("createInstallationPort (unit)", () => {
  it("scopes to the given App's installation per call and sends simple names", async () => {
    const seen: string[] = [];
    const port = createInstallationPort({
      listOrgInstallations: async () => [
        { id: 1, appId: 10 },
        { id: 2, appId: 20 },
      ],
      listInstallationRepositories: async (_o, id) => {
        seen.push(`list:${id}`);
        return [{ fullName: "acme/a" }];
      },
      addRepositories: async (_o, id, names) => {
        seen.push(`add:${id}:${names.join(",")}`);
      },
      removeRepositories: async (_o, id, names) => {
        seen.push(`rm:${id}:${names.join(",")}`);
      },
    });
    expect(await port.listRepos(20, ["acme"])).toEqual({ acme: ["acme/a"] });
    await port.addRepos(20, "acme", ["acme/b"]);
    await port.removeRepos(10, "acme", ["acme/c", "acme/d"]);
    expect(seen).toEqual(["list:2", "add:2:b", "rm:1:c,d"]);
  });

  it("names the org when the App is not installed there", async () => {
    const port = createInstallationPort({
      listOrgInstallations: async () => [{ id: 1, appId: 10 }],
      listInstallationRepositories: async () => [],
      addRepositories: async () => {},
      removeRepositories: async () => {},
    });
    await expect(port.listRepos(99, ["acme"])).rejects.toThrow(
      /99.*not installed on org acme/,
    );
  });
});

describe("ReconcileApplyService.planWithOpenWork (unit)", () => {
  const removing = { repos: ["acme/a", "acme/b"], pushable: ["acme/a"] };

  it("lists open work on the repos the plan removes", async () => {
    const seen: (readonly string[])[] = [];
    const { svc } = build({
      ...removing,
      openWork: {
        listOpenWork: async (_a, repos) => {
          seen.push(repos);
          return [{ id: "t1", repo: "acme/b", title: "x" }];
        },
        blockOpenWork: async () => {},
      },
    });
    const res = await svc.planWithOpenWork("a1");
    expect(seen).toEqual([["acme/b"]]);
    expect(res.openWork).toEqual([{ id: "t1", repo: "acme/b", title: "x" }]);
    expect(res.plan.diff.configRemoves).toEqual(["acme/b"]);
  });

  it("returns an empty list with no port", async () => {
    const { svc } = build(removing);
    expect((await svc.planWithOpenWork("a1")).openWork).toEqual([]);
  });

  it("a port failure becomes a warning, not an error", async () => {
    const { svc } = build({
      ...removing,
      openWork: {
        listOpenWork: async () => {
          throw new Error("store down");
        },
        blockOpenWork: async () => {},
      },
    });
    const res = await svc.planWithOpenWork("a1");
    expect(res.openWork).toEqual([]);
    expect(res.plan.warnings.join(" ")).toContain("store down");
  });
});
