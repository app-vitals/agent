import { describe, expect, it } from "bun:test";
import {
  accessFor,
  envWith,
  fakeOpenWork,
  fakePrisma,
  freshCache,
  withLookupSnapshots,
} from "./github-installation.fixtures.ts";
import {
  createGithubInstallationRepos,
  createGithubSync,
} from "./github-installation-wiring.ts";
import type { GitHubEnterpriseAppMetadata } from "./github-enterprise-apps.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";

const noApp = { get: async () => null, getPrivateKey: async () => null };

const portWith = (
  seen: number[],
  repos: string[] = ["acme/old", "acme/api"],
): InstallationReposPort => ({
  listRepos: async (appId) => {
    seen.push(appId);
    return { acme: repos };
  },
  listInstalled: async (appId) => {
    seen.push(appId);
    return { status: "found", orgs: [{ org: "acme", repos }] };
  },
  addRepos: async () => {},
  removeRepos: async () => {},
});

describe("createGithubInstallationRepos", () => {
  it("lists from the cache under the agent's own stored GH_APP_ID, without GitHub", async () => {
    const seen: number[] = [];
    const { prisma, state } = fakePrisma(["acme/old"]);
    const svc = createGithubInstallationRepos({
      prisma,
      appService: noApp,
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: " 77 " }),
      installationRepos: portWith(seen),
    });
    const res = await svc.list("a1");
    // The port (live GitHub) is never used; the cache is read for App 77.
    expect(seen).toEqual([]);
    expect(state.snapshotQueries).toMatchObject([
      { where: { appKind: "agent", appRef: "77" } },
    ]);
    expect(res).toMatchObject({ status: "ok", appId: 77, complete: false });
  });

  it("reports an agent with no GH_APP_ID, naming the missing var", async () => {
    const { prisma } = fakePrisma(["acme/old"]);
    const envs: (Record<string, string> | undefined)[] = [
      undefined,
      { OTHER: "x" },
      { GH_APP_ID: "abc" },
    ];
    for (const env of envs) {
      const svc = createGithubInstallationRepos({
        prisma,
        appService: noApp,
        access: accessFor([]),
        agentEnv: envWith(env),
        installationRepos: portWith([]),
      });
      const res = await svc.list("a1");
      expect(res.status).toBe("no_app_id");
      if (res.status === "no_app_id") expect(res.reason).toContain("GH_APP_ID");
    }
  });
});

describe("createGithubSync", () => {
  const ALL = ["acme/old", "acme/api"];
  const build = (
    openWork?: ReturnType<typeof fakeOpenWork>["port"],
    opts: { checkedAt?: Date; verify?: boolean | undefined } = {},
  ) => {
    const checkedAt = opts.checkedAt ?? new Date();
    const { prisma, state } = fakePrisma(
      ALL,
      freshCache("acme", ALL, ["acme/api"], checkedAt),
    );
    const verified: string[] = [];
    const svc = createGithubSync({
      prisma,
      appService: noApp,
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: "42" }),
      installationRepos: portWith([]),
      syncOverrides: {
        lookupRepos: async () => [
          { org: "acme", completedAt: checkedAt, repos: ALL },
        ],
        verifyPush: async (_u, repo) => {
          verified.push(repo);
          return "verify" in opts ? opts.verify : false;
        },
      },
      openWork,
    });
    return { svc, state, verified };
  };

  it("with a port: preview lists affected open work and apply blocks it", async () => {
    const { port, calls } = fakeOpenWork();
    const { svc, state } = build(port);
    const preview = await svc.preview("a1");
    expect(preview.status).toBe("previewed");
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: ["acme/old"],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("applied");
    expect(state.repos).toEqual(["acme/api"]);
    const block = calls.find((c) => c.fn === "block");
    expect(block?.args[0]).toBe("a1");
    expect(block?.args[1]).toEqual(["acme/old"]);
  });

  it("without a port: nothing is blocked, apply still works", async () => {
    const { svc, state } = build();
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: [],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("applied");
    expect(state.repos).toEqual(["acme/api"]);
  });

  it("reads the cache: a stale org is skipped with the reason and nothing is removed", async () => {
    const old = new Date(Date.now() - 24 * 3_600_000);
    const { svc, state, verified } = build(undefined, { checkedAt: old });
    const preview = await svc.preview("a1");
    if (preview.status !== "previewed") throw new Error(preview.status);
    expect(preview.plan.removedRepos).toEqual([]);
    expect(preview.plan.skippedOrgs[0]?.reason).toContain("stale (checked");
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: ["acme/old"],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("noop");
    expect(verified).toEqual([]);
    expect(state.repos).toEqual(ALL);
  });

  it("apply drops a candidate the live re-check still sees as pushable", async () => {
    const { svc, state, verified } = build(undefined, { verify: true });
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      appAdds: [],
      appRemoves: [],
      agentRemoves: ["acme/old"],
    });
    expect(res.status).toBe("noop");
    expect(verified).toEqual(["acme/old"]);
    expect(state.repos).toEqual(ALL);
  });
});

describe("createGithubSync lookup snapshot read", () => {
  const ALL = ["acme/old", "acme/api"];
  const now = new Date();
  // A real lookupRepos (no syncOverrides): the lookup App's snapshots are read
  // from the cache under the agent's account key, plus the deployment-wide key.
  const build = (
    lookupAccountId: string | null,
    lookupRows: Parameters<typeof withLookupSnapshots>[1],
    agentAccountId?: string,
  ) => {
    const { prisma, state } = fakePrisma(
      ALL,
      freshCache("acme", ALL, ["acme/api"], now),
    );
    if (agentAccountId !== undefined) {
      (
        prisma.agent as unknown as { findUnique: () => Promise<unknown> }
      ).findUnique = async () => ({
        id: "a1",
        repos: state.repos,
        githubUsername: "dev",
        accountId: agentAccountId,
      });
    }
    withLookupSnapshots(prisma, lookupRows);
    const svc = createGithubSync({
      prisma,
      appService: {
        get: async () =>
          ({
            accountId: lookupAccountId,
            appId: "99",
            updatedAt: now,
          }) as unknown as GitHubEnterpriseAppMetadata,
        getPrivateKey: async () => "test-key",
      },
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: "42" }),
      installationRepos: portWith([], ALL),
      now: () => now,
    });
    return { svc, state };
  };
  const lookupAcme = (accountId: string) => ({
    accountId,
    appRef: "99",
    org: "acme",
    completedAt: now,
    repos: ALL.map((fullName) => ({ fullName })),
  });

  it('a null-account agent finds the lookup snapshot filed under "deployment"', async () => {
    const { svc, state } = build(null, [lookupAcme("deployment")]);
    const preview = await svc.preview("a1");
    if (preview.status !== "previewed") throw new Error(preview.status);
    // The org is complete and fresh, so it is not skipped for missing lookup data.
    expect(preview.plan.skippedOrgs).toEqual([]);
    const lookupQueries = state.snapshotQueries.filter(
      (q) => (q as { where: { appKind?: string } }).where.appKind === "lookup",
    );
    expect(lookupQueries).toMatchObject([
      { where: { accountId: { in: ["deployment"] }, appRef: "99" } },
    ]);
  });

  it("an account-scoped agent reads its own account's and the deployment-wide lookup snapshots", async () => {
    const { svc, state } = build("acct-1", [lookupAcme("acct-1")], "acct-1");
    const preview = await svc.preview("a1");
    if (preview.status !== "previewed") throw new Error(preview.status);
    expect(preview.plan.skippedOrgs).toEqual([]);
    const lookupQueries = state.snapshotQueries.filter(
      (q) => (q as { where: { appKind?: string } }).where.appKind === "lookup",
    );
    expect(lookupQueries).toMatchObject([
      { where: { accountId: { in: ["acct-1", "deployment"] }, appRef: "99" } },
    ]);
  });

  it("with no lookup snapshot under the agent's key, the org is skipped as incomplete", async () => {
    const { svc } = build(null, [lookupAcme("some-other-account")]);
    const preview = await svc.preview("a1");
    if (preview.status !== "previewed") throw new Error(preview.status);
    expect(preview.plan.skippedOrgs).toEqual([
      { org: "acme", reason: "access data is incomplete" },
    ]);
  });
});
