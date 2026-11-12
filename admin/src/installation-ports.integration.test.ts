/**
 * admin/src/installation-ports.integration.test.ts
 * Integration tests for the Prisma-backed agent and audit adapters against a
 * real DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentEnvService } from "./agent-envs.ts";
import {
  PrismaInstallationAgents,
  PrismaInstallationAudit,
} from "./installation-ports.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { identityCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("installation ports (integration)", () => {
  let prisma: PrismaClient;

  const env = () => new AgentEnvService(prisma, identityCrypto);

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
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("reads the agent's own GH_APP_ID and writes its repos", async () => {
    const a = await prisma.agent.create({
      data: { name: "A", repos: ["acme/a"], githubUsername: "dev" },
    });
    const agents = new PrismaInstallationAgents(prisma, env());
    expect((await agents.get(a.id))?.appId).toBeUndefined();
    await env().patch(a.id, { GH_APP_ID: "42" });
    expect(await agents.get(a.id)).toMatchObject({
      id: a.id,
      repos: ["acme/a"],
      githubUsername: "dev",
      appId: 42,
    });
    await agents.setRepos(a.id, ["acme/b"]);
    expect((await agents.get(a.id))?.repos).toEqual(["acme/b"]);
    expect(await agents.get("missing")).toBeNull();
  });

  it("writes one audit row per entry and returns its id", async () => {
    const a = await prisma.agent.create({ data: { name: "A", repos: [] } });
    const audit = new PrismaInstallationAudit(prisma);
    const id = await audit.write({
      agentId: a.id,
      caller: "dan@x.io",
      planHash: "direct:add",
      diff: {
        installationAdds: ["acme/c"],
        installationRemoves: [],
        configAdds: [],
        configRemoves: [],
      },
      result: { status: "applied" },
    });
    const rows = await prisma.gitHubReconcileAudit.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      agentId: a.id,
      caller: "dan@x.io",
      planHash: "direct:add",
      result: { status: "applied" },
    });
  });
});
