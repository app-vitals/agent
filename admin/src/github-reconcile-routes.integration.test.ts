/**
 * admin/src/github-reconcile-routes.integration.test.ts
 * POST /agents/:id/github-reconcile/{plan,apply} (GHE-3.4) against a real DB:
 * stale plan hash -> 409, removal cap -> 422, then a confirmed apply. GitHub is
 * faked.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentService } from "./agents.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { NoopChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import {
  MAX_UNCONFIRMED_REMOVALS,
  PrismaReconcileAgents,
  PrismaReconcileAudit,
  ReconcileApplyService,
} from "./reconcile-apply-service.ts";
import { identityCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;
const KEY = "reconcile-admin-key";

describeOrSkip("github reconcile routes (integration)", () => {
  let prisma: PrismaClient;
  let pushable: string[];
  let installed: string[];

  const buildApp = () => {
    const reconcile = new ReconcileApplyService({
      agents: new PrismaReconcileAgents(prisma),
      access: async () => ({
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
      }),
      installation: {
        listRepos: async () => ({ acme: [...installed] }),
        addRepos: async () => {},
        removeRepos: async () => {},
      },
      audit: new PrismaReconcileAudit(prisma),
    });
    return createAdminApp({
      agentService: new AgentService(prisma),
      agentEnvService: new AgentEnvService(prisma, identityCrypto),
      agentCronJobService: new AgentCronJobService(prisma),
      agentCronRunService: new AgentCronRunService(prisma),
      agentCronRunStatsService: new AgentCronRunStatsService(prisma),
      agentToolService: new AgentToolService(prisma),
      agentTokenService: new AgentTokenService(prisma),
      agentPluginService: new AgentPluginService(prisma),
      agentMemberService: new AgentMemberService(prisma),
      specialtyRegistry: {
        getType: () => {
          throw new Error("unused");
        },
        tryGetType: () => undefined,
        listTypes: () => [],
      },
      agentChatTokenService: new AgentChatTokenService(prisma),
      agentGitHubInstallationsService: new AgentGitHubInstallationsService(
        prisma,
      ),
      prisma,
      provisioner: new NoopAgentProvisioner(),
      serviceIntegrations: [],
      chatService: new NoopChatServiceProvisioningClient(),
      slack: { deleteApp: async () => {} },
      decrypt: (v: string) => v,
      sessionSecret: "test-admin-session-secret-32-bytes!",
      adminApiKeys: parseAdminApiKeys(`root:${KEY}:*`),
      githubReconcile: reconcile,
    });
  };

  const call = (
    app: ReturnType<typeof createAdminApp>,
    id: string,
    action: "plan" | "apply",
    body: unknown,
  ) =>
    app.request(`/agents/${id}/github-reconcile/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

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
    pushable = [];
    installed = [];
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("409 when the hash is stale, and nothing is written", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", repos: ["acme/a", "acme/b"], githubUsername: "dev" },
    });
    installed = ["acme/a", "acme/b"];
    pushable = ["acme/a"];
    const app = buildApp();
    const plan = (await (await call(app, agent.id, "plan", {})).json()) as {
      planHash: string;
    };
    pushable = []; // access changed after the plan was reviewed
    const res = await call(app, agent.id, "apply", {
      planHash: plan.planHash,
    });
    expect(res.status).toBe(409);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(0);
    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.repos).toEqual(["acme/a", "acme/b"]);
  });

  it("422 over the removal cap, then applies with confirmRemovals", async () => {
    const repos = Array.from(
      { length: MAX_UNCONFIRMED_REMOVALS + 1 },
      (_, i) => `acme/r${i}`,
    );
    const agent = await prisma.agent.create({
      data: { name: "A", repos, githubUsername: "dev" },
    });
    installed = [...repos];
    pushable = ["acme/keep"];
    const app = buildApp();
    const plan = (await (await call(app, agent.id, "plan", {})).json()) as {
      planHash: string;
      diff: { configRemoves: string[] };
    };
    expect(plan.diff.configRemoves).toHaveLength(repos.length);
    const capped = await call(app, agent.id, "apply", {
      planHash: plan.planHash,
    });
    expect(capped.status).toBe(422);
    expect(await prisma.gitHubReconcileAudit.count()).toBe(0);

    const ok = await call(app, agent.id, "apply", {
      planHash: plan.planHash,
      confirmRemovals: true,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; auditId: string };
    expect(body.status).toBe("applied");
    const audit = await prisma.gitHubReconcileAudit.findUniqueOrThrow({
      where: { id: body.auditId },
    });
    expect(audit.agentId).toBe(agent.id);
  });
});
