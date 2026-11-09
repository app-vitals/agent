/**
 * admin/src/agents-api.specialty.integration.test.ts
 * SAL-1.2: PATCH /agents/:id { specialty } against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import type {
  AgentProvisioner,
  ReconcileResult,
  ReconcileTarget,
} from "./agent-provisioner.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentService } from "./agents.ts";
import type { AdminDeps } from "./agents-api.ts";
import { createAdminApp } from "./agents-api.ts";
import { NoopChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { SpecialtyTypes } from "./specialty-types.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const REAL_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

async function makeSessionCookie(): Promise<string> {
  return sign(
    {
      isAdmin: true,
      userId: "user-123",
      email: "admin@example.com",
      name: "Admin User",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

/** Injected provisioner double that records every reconcile target. */
class RecordingProvisioner extends NoopAgentProvisioner {
  readonly reconciled: ReconcileTarget[] = [];
  override async reconcile(
    agents: ReconcileTarget[],
  ): Promise<ReconcileResult> {
    this.reconciled.push(...agents);
    return {
      recreated: [],
      migrated: [],
      noOwner: [],
      dryRun: false,
      updated: [],
      orphans: [],
      failed: [],
    };
  }
}

function makeDeps(
  prisma: PrismaClient,
  provisioner: AgentProvisioner,
): AdminDeps {
  const saved = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
  const crypto = makeTokenCrypto();
  if (saved === undefined) delete process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  else process.env.SHIPWRIGHT_ENCRYPTION_KEY = saved;
  const specialtyRegistry = new SpecialtyTypes();
  return {
    agentService: new AgentService(prisma),
    agentEnvService: new AgentEnvService(prisma, crypto),
    agentCronJobService: new AgentCronJobService(
      prisma,
      undefined,
      specialtyRegistry,
    ),
    agentCronRunService: new AgentCronRunService(prisma),
    agentCronRunStatsService: new AgentCronRunStatsService(prisma),
    agentToolService: new AgentToolService(prisma),
    agentTokenService: new AgentTokenService(prisma),
    agentPluginService: new AgentPluginService(prisma),
    agentMemberService: new AgentMemberService(prisma),
    specialtyRegistry,
    agentChatTokenService: new AgentChatTokenService(prisma),
    agentGitHubInstallationsService: new AgentGitHubInstallationsService(
      prisma,
    ),
    prisma,
    provisioner,
    serviceIntegrations: [
      {
        name: "task-store",
        listTokensForAgent: async () => [],
        revokeToken: async () => {},
      },
    ],
    chatService: new NoopChatServiceProvisioningClient(),
    slack: { deleteApp: async () => {} },
    decrypt: (value: string) => crypto.decrypt(value),
    sessionSecret: SESSION_SECRET,
  };
}

describeOrSkip("PATCH /agents/:id specialty (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentCronJob.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("flips Agent.specialty and reconciles a Saul-shaped cron set against the specialist type", async () => {
    const agent = await prisma.agent.create({
      data: { name: "Saul", specialty: "saul" },
    });
    const systemNames = [
      "shipwright-dev-loop",
      "shipwright-dev-task",
      "shipwright-review",
      "shipwright-patch",
      "shipwright-deploy",
      "shipwright-entropy-scan",
      "shipwright-security-scan",
      "shipwright-error-scan",
      "shipwright-learn-dream-sys",
    ];
    for (const name of systemNames) {
      await prisma.agentCronJob.create({
        data: {
          agentId: agent.id,
          name,
          system: true,
          schedule: "0 * * * *",
          prompt: `/${name}`,
          enabled: false,
        },
      });
    }
    const userCron = await prisma.agentCronJob.create({
      data: {
        agentId: agent.id,
        name: "learn-dream",
        system: false,
        schedule: "0 3 * * *",
        prompt: "/learn-dream",
        enabled: true,
      },
    });
    for (let i = 0; i < 2; i++) {
      await prisma.agentCronRun.create({
        data: {
          cronId: userCron.id,
          agentId: agent.id,
          startedAt: new Date(Date.now() - i * 60_000),
        },
      });
    }

    const provisioner = new RecordingProvisioner();
    const app = createAdminApp(makeDeps(prisma, provisioner));
    const cookie = await makeSessionCookie();
    const res = await app.request(`/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ specialty: "specialist" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).specialty).toBe("specialist");
    const row = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(row.specialty).toBe("specialist");
    expect(
      await prisma.agentCronJob.count({
        where: { agentId: agent.id, system: true },
      }),
    ).toBe(0);
    const survivors = await prisma.agentCronJob.findMany({
      where: { agentId: agent.id },
    });
    expect(survivors.map((c) => c.id)).toEqual([userCron.id]);
    expect(survivors[0]?.system).toBe(false);
    expect(
      await prisma.agentCronRun.count({ where: { cronId: userCron.id } }),
    ).toBe(2);
    // selfHosted defaults false, so the workload reconcile ran once.
    expect(provisioner.reconciled).toHaveLength(1);
    expect(provisioner.reconciled[0]?.id).toBe(agent.id);
    expect(provisioner.reconciled[0]?.specialty).toBe("specialist");
  });
});

describeOrSkip("GET /agents/:id/specialty-change-preview (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentCronJob.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("reports a Saul-shaped agent and writes nothing", async () => {
    const agent = await prisma.agent.create({
      data: { name: "Saul", specialty: "saul" },
    });
    const systemNames = [
      "shipwright-dev-loop",
      "shipwright-dev-task",
      "shipwright-review",
      "shipwright-patch",
      "shipwright-deploy",
      "shipwright-entropy-scan",
      "shipwright-security-scan",
      "shipwright-error-scan",
      "shipwright-learn-dream-sys",
    ];
    for (const name of systemNames) {
      await prisma.agentCronJob.create({
        data: {
          agentId: agent.id,
          name,
          system: true,
          schedule: "0 * * * *",
          prompt: `/${name}`,
          enabled: false,
        },
      });
    }
    await prisma.agentCronJob.create({
      data: {
        agentId: agent.id,
        name: "learn-dream",
        system: false,
        schedule: "0 3 * * *",
        prompt: "/learn-dream",
        enabled: true,
      },
    });

    const snapshot = async () =>
      JSON.stringify({
        agent: await prisma.agent.findMany({ orderBy: { id: "asc" } }),
        crons: await prisma.agentCronJob.findMany({ orderBy: { id: "asc" } }),
      });
    const before = await snapshot();

    const provisioner = new RecordingProvisioner();
    const coding = { repository: "ghcr.io/x/coding", tag: "1.0.0" };
    const fallbackDefault = { repository: "ghcr.io/x/default", tag: "2.0.0" };
    const app = createAdminApp({
      ...makeDeps(prisma, provisioner),
      agentImages: {
        fallback: { repository: "ghcr.io/x/single", tag: "0.0.1" },
        images: { saul: coding, default: fallbackDefault },
      },
    });
    const cookie = await makeSessionCookie();
    const res = await app.request(
      `/agents/${agent.id}/specialty-change-preview?to=specialist`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBe("saul");
    expect(body.to).toBe("specialist");
    expect(body.imageBefore).toBe("ghcr.io/x/coding:1.0.0");
    expect(body.imageAfter).toBe("ghcr.io/x/default:2.0.0");
    expect(body.crons.kept).toEqual([]);
    expect(
      body.crons.deleted.map((c: { name: string }) => c.name).sort(),
    ).toEqual([...systemNames].sort());
    expect(JSON.stringify(body.crons)).not.toContain(`"learn-dream"`);
    expect(body.rollbackNote).toBeNull();
    expect(await snapshot()).toBe(before);
    expect(provisioner.reconciled).toEqual([]);
  });
});
