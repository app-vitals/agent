import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import { createGithubReconcile } from "./github-reconcile-wiring.ts";
import type { ReconcileInstallationPort } from "./reconcile-apply-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";

export const accessFor = (pushable: string[]): GithubAccessPreviewFn => {
  return async () => ({
    status: "ok",
    access: {
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
    },
  });
};

export function fakePrisma(repos: string[]) {
  const state = { repos: [...repos], audits: 0 };
  const prisma = {
    agent: {
      findUnique: async () => ({
        id: "a1",
        repos: state.repos,
        githubUsername: "dev",
      }),
      update: async (args: { data: { repos: string[] } }) => {
        state.repos = args.data.repos;
      },
    },
    gitHubReconcileAudit: {
      create: async () => {
        state.audits += 1;
        return { id: "audit-1" };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, state };
}

export function fakeOpenWork() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const port: OpenWorkPort = {
    listOpenWork: async (...args) => {
      calls.push({ fn: "list", args });
      return [{ id: "T-1", repo: "acme/old", title: "fix it" }];
    },
    blockOpenWork: async (...args) => {
      calls.push({ fn: "block", args });
    },
  };
  return { port, calls };
}

export const envWith = (env?: Record<string, string>) => ({
  getConfigBundle: async (agentId: string) =>
    env ? { env, agentId, allowedTools: [] } : null,
});

const installation: ReconcileInstallationPort = {
  listRepos: async () => ({ acme: ["acme/old", "acme/api"] }),
  addRepos: async () => {},
  removeRepos: async () => {},
};

const build = (openWork?: OpenWorkPort) => {
  const { prisma, state } = fakePrisma(["acme/old"]);
  const svc = createGithubReconcile({
    prisma,
    appService: { get: async () => null, getPrivateKey: async () => null },
    access: accessFor(["acme/api"]),
    agentEnv: envWith({ GH_APP_ID: "42" }),
    installation,
    openWork,
  });
  if (!svc) throw new Error("expected a reconcile service");
  return { svc, state };
};

describe("createGithubReconcile", () => {
  it("plans from the agent's own stored GH_APP_ID", async () => {
    const seen: number[] = [];
    const { prisma } = fakePrisma(["acme/old"]);
    const svc = createGithubReconcile({
      prisma,
      appService: { get: async () => null, getPrivateKey: async () => null },
      access: accessFor(["acme/api"]),
      agentEnv: envWith({ GH_APP_ID: " 77 " }),
      installation: {
        ...installation,
        listRepos: async (appId) => {
          seen.push(appId);
          return { acme: ["acme/old", "acme/api"] };
        },
      },
    });
    const plan = await svc.plan("a1");
    expect(seen).toEqual([77]);
    expect(plan.skipped).toBe(false);
  });

  it("skips an agent with no GH_APP_ID, naming the missing var", async () => {
    const { prisma } = fakePrisma(["acme/old"]);
    const envs: (Record<string, string> | undefined)[] = [
      undefined,
      { OTHER: "x" },
      { GH_APP_ID: "abc" },
    ];
    for (const env of envs) {
      const svc = createGithubReconcile({
        prisma,
        appService: { get: async () => null, getPrivateKey: async () => null },
        access: accessFor([]),
        agentEnv: envWith(env),
        installation,
      });
      const plan = await svc.plan("a1");
      expect(plan.skipped).toBe(true);
      expect(plan.skipReason).toContain("GH_APP_ID");
    }
  });

  it("with a port: plan lists affected open work and apply blocks it", async () => {
    const { port, calls } = fakeOpenWork();
    const { svc } = build(port);
    const { plan, openWork } = await svc.planWithOpenWork("a1");
    expect(plan.diff.configRemoves).toEqual(["acme/old"]);
    expect(openWork).toEqual([
      { id: "T-1", repo: "acme/old", title: "fix it" },
    ]);
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
    const block = calls.find((c) => c.fn === "block");
    expect(block?.args[0]).toBe("a1");
    expect(block?.args[1]).toEqual(["acme/old"]);
  });

  it("without a port: nothing is listed or blocked, apply still works", async () => {
    const { svc, state } = build();
    const { plan, openWork } = await svc.planWithOpenWork("a1");
    expect(openWork).toEqual([]);
    const res = await svc.apply({
      agentId: "a1",
      caller: "root",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
    expect(state.repos).toEqual([]);
  });
});
