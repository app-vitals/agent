/**
 * admin/src/agent-github-username.integration.test.ts
 * Integration tests for the Agent.githubUsername column (GHE-2.1) against a
 * real PostgreSQL DB.
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
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentService } from "./agents.ts";
import type { AdminDeps } from "./agents-api.ts";
import { createAdminApp } from "./agents-api.ts";
import { NoopChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type {
  SpecialtyType,
  SpecialtyTypeResolver,
} from "./specialty-types.ts";
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

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

const CODING_TYPE: SpecialtyType = {
  name: "coding",
  displayName: "Coding Agent",
  templatesDir: "workspace/",
  tools: ["Read", "Write", "Edit"],
  requiredEnv: [],
};

function fakeSpecialtyTypes(): SpecialtyTypeResolver {
  const byType: Record<string, SpecialtyType> = { coding: CODING_TYPE };
  return {
    getType(specialty: string): SpecialtyType {
      return byType[specialty] ?? (byType.coding as SpecialtyType);
    },
    tryGetType(specialty: string): SpecialtyType | undefined {
      return byType[specialty];
    },
    listTypes() {
      return Object.entries(byType).map(([name, manifest]) => ({
        name,
        displayName: manifest.displayName,
      }));
    },
  };
}

function makeDeps(prisma: PrismaClient): AdminDeps {
  const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
  const crypto = makeTokenCrypto();
  if (savedKey === undefined) {
    delete process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  } else {
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;
  }

  return {
    agentService: new AgentService(prisma),
    agentEnvService: new AgentEnvService(prisma, crypto),
    agentCronJobService: new AgentCronJobService(prisma),
    agentCronRunService: new AgentCronRunService(prisma),
    agentCronRunStatsService: new AgentCronRunStatsService(prisma),
    agentToolService: new AgentToolService(prisma),
    agentTokenService: new AgentTokenService(prisma),
    agentPluginService: new AgentPluginService(prisma),
    agentMemberService: new AgentMemberService(prisma),
    specialtyRegistry: fakeSpecialtyTypes(),
    agentChatTokenService: new AgentChatTokenService(prisma),
    agentGitHubInstallationsService: new AgentGitHubInstallationsService(
      prisma,
    ),
    prisma,
    provisioner: new NoopAgentProvisioner(),
    serviceIntegrations: [
      {
        name: "task-store",
        listTokensForAgent: async () => [],
        revokeToken: async () => {},
      },
    ],
    chatService: new NoopChatServiceProvisioningClient(),
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => crypto.decrypt(value),
    sessionSecret: SESSION_SECRET,
  };
}

describeOrSkip("Agent.githubUsername (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("migration adds exactly one nullable, non-unique text column; existing rows are NULL", async () => {
    const cols = await prisma.$queryRaw<
      Array<{ data_type: string; is_nullable: string }>
    >`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'Agent' AND column_name = 'githubUsername'`;
    expect(cols).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const idx = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'Agent' AND indexdef LIKE '%githubUsername%'`;
    expect(idx).toEqual([]);
    const agent = await prisma.agent.create({ data: { name: "Legacy" } });
    expect(agent.githubUsername).toBeNull();
  });

  it("set, get, and clear round-trip via PATCH/GET, lower-cased, duplicates allowed", async () => {
    const a = await prisma.agent.create({ data: { name: "A" } });
    const b = await prisma.agent.create({ data: { name: "B" } });
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeDeps(prisma));
    const send = (id: string, method: string, body?: unknown) =>
      app.request(`/agents/${id}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      });

    const set = await send(a.id, "PATCH", { githubUsername: "Octo-Cat" });
    expect(set.status).toBe(200);
    expect((await set.json()).githubUsername).toBe("octo-cat");
    expect((await (await send(a.id, "GET")).json()).githubUsername).toBe(
      "octo-cat",
    );

    // No uniqueness: a second agent may use the same login.
    const dup = await send(b.id, "PATCH", { githubUsername: "octo-cat" });
    expect(dup.status).toBe(200);

    // Unrelated PATCH leaves it unchanged.
    await send(a.id, "PATCH", { selfHosted: false });
    expect((await (await send(a.id, "GET")).json()).githubUsername).toBe(
      "octo-cat",
    );

    const bad = await send(a.id, "PATCH", { githubUsername: "a--b" });
    expect(bad.status).toBe(422);

    const cleared = await send(a.id, "PATCH", { githubUsername: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).githubUsername).toBeNull();
    const row = await prisma.agent.findUnique({ where: { id: a.id } });
    expect(row?.githubUsername).toBeNull();
  });
});
