/**
 * admin/src/reconcile-apply-service.integration.test.ts
 * Integration tests for ReconcileApplyService against a real DB (audit table,
 * agent config); GitHub is faked.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentEnvService } from "./agent-envs.ts";
import type { GithubAccessPreview } from "./github-access-preview.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import {
  PrismaReconcileAgents,
  PrismaReconcileAudit,
  ReconcileApplyService,
} from "./reconcile-apply-service.ts";
import { identityCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function accessFor(pushable: string[]): GithubAccessPreview {
  return {
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
  };
}

describeOrSkip("ReconcileApplyService (integration)", () => {
  let prisma: PrismaClient;
  let calls: string[];
  let installed: string[];
  let pushable: string[];
  let unconfigured: boolean;

  const service = (): ReconcileApplyService =>
    new ReconcileApplyService({
      agents: {
        get: (id) => new PrismaReconcileAgents(prisma, envService()).get(id),
        setRepos: async (id, repos) => {
          calls.push("config");
          await new PrismaReconcileAgents(prisma, envService()).setRepos(
            id,
            repos,
          );
        },
      },
      access: async () =>
        unconfigured ? { status: "unconfigured" } : accessFor(pushable),
      installation: {
        listRepos: async () => ({ acme: [...installed] }),
        addRepos: async (_o, repos) => {
          calls.push("inst-add");
          installed.push(...repos);
        },
        removeRepos: async (_o, repos) => {
          calls.push("inst-remove");
          installed = installed.filter((r) => !repos.includes(r));
        },
      },
      audit: new PrismaReconcileAudit(prisma),
    });

  const envService = () => new AgentEnvService(prisma, identityCrypto);

  async function makeAgent(
    repos: string[],
    githubUsername: string | null = "dev",
  ) {
    const a = await prisma.agent.create({
      data: { name: "A", repos, githubUsername },
    });
    await envService().patch(a.id, { GH_APP_ID: "42" });
    installed = [...repos];
    return a.id;
  }

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubReconcileAudit.deleteMany();
    await prisma.agentGitHubInstallationsSnapshot.deleteMany();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    calls = [];
    installed = [];
    pushable = [];
    unconfigured = false;
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("applies installation changes before agent config and writes an audit entry", async () => {
    const id = await makeAgent(["acme/a", "acme/b"]);
    pushable = ["acme/a", "acme/c"];
    const svc = service();
    const plan = await svc.plan(id, ["acme/c"]);
    const res = await svc.apply({
      agentId: id,
      caller: "dan@x.io",
      planHash: plan.planHash,
      namedAdds: ["acme/c"],
    });
    expect(res.status).toBe("applied");
    expect(calls).toEqual(["inst-add", "inst-remove", "config"]);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } });
    expect(agent.repos).toEqual(["acme/a", "acme/c"]);
    const audits = await prisma.gitHubReconcileAudit.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      agentId: id,
      caller: "dan@x.io",
      planHash: plan.planHash,
      result: { status: "applied" },
    });
    expect(audits[0]?.diff).toMatchObject({
      configAdds: ["acme/c"],
      configRemoves: ["acme/b"],
    });
  });

  it("refuses a stale plan hash and changes nothing", async () => {
    const id = await makeAgent(["acme/a", "acme/b"]);
    pushable = ["acme/a"];
    const res = await service().apply({
      agentId: id,
      caller: "c",
      planHash: "stale",
    });
    expect(res.status).toBe("stale_plan");
    expect(calls).toEqual([]);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(0);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } });
    expect(agent.repos).toEqual(["acme/a", "acme/b"]);
  });

  it("refuses more than 10 removals unless confirmRemovals is set", async () => {
    const repos = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
    const id = await makeAgent(repos);
    pushable = [];
    const svc = service();
    const plan = await svc.plan(id);
    const refused = await svc.apply({
      agentId: id,
      caller: "c",
      planHash: plan.planHash,
    });
    expect(refused.status).toBe("removal_cap");
    expect(calls).toEqual([]);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(0);

    const ok = await svc.apply({
      agentId: id,
      caller: "c",
      planHash: plan.planHash,
      confirmRemovals: true,
    });
    expect(ok.status).toBe("applied");
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } });
    expect(agent.repos).toEqual([]);
  });

  it("allows exactly 10 removals without confirmation", async () => {
    const repos = Array.from({ length: 10 }, (_, i) => `acme/r${i}`);
    const id = await makeAgent(repos);
    const svc = service();
    const plan = await svc.plan(id);
    const res = await svc.apply({
      agentId: id,
      caller: "c",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("applied");
  });

  it("is idempotent: a second apply with no drift does nothing", async () => {
    const id = await makeAgent(["acme/a", "acme/b"]);
    pushable = ["acme/a"];
    const svc = service();
    const plan = await svc.plan(id);
    await svc.apply({ agentId: id, caller: "c", planHash: plan.planHash });
    calls = [];
    const again = await svc.apply({
      agentId: id,
      caller: "c",
      planHash: plan.planHash,
    });
    expect(again.status).toBe("noop");
    expect(calls).toEqual([]);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(1);
  });

  it("a skipped plan writes no audit entry and changes nothing", async () => {
    const noUser = await makeAgent(["acme/a"], null);
    const r1 = await service().apply({
      agentId: noUser,
      caller: "c",
      planHash: "x",
    });
    expect(r1.status).toBe("skipped");

    unconfigured = true;
    const bound = await makeAgent(["acme/a"]);
    const r2 = await service().apply({
      agentId: bound,
      caller: "c",
      planHash: "x",
    });
    expect(r2.status).toBe("skipped");
    expect(calls).toEqual([]);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(0);
  });

  it("records a failed audit when an installation call fails and leaves config alone", async () => {
    const id = await makeAgent(["acme/a", "acme/b"]);
    pushable = ["acme/a"];
    const base = service();
    const plan = await base.plan(id);
    const failing = new ReconcileApplyService({
      agents: new PrismaReconcileAgents(prisma, envService()),
      access: async () => accessFor(pushable),
      installation: {
        listRepos: async () => ({ acme: [...installed] }),
        addRepos: async () => {},
        removeRepos: async () => {
          throw new Error("422 last repository");
        },
      },
      audit: new PrismaReconcileAudit(prisma),
    });
    const res = await failing.apply({
      agentId: id,
      caller: "c",
      planHash: plan.planHash,
    });
    expect(res.status).toBe("failed");
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } });
    expect(agent.repos).toEqual(["acme/a", "acme/b"]);
    const [audit] = await prisma.gitHubReconcileAudit.findMany();
    expect(audit?.result).toMatchObject({ status: "failed" });
  });
});
