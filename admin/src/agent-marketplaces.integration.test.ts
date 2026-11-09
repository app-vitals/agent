/**
 * admin/src/agent-marketplaces.integration.test.ts
 * Integration tests for the AgentMarketplace model against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("AgentMarketplace (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentMarketplace.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function createAgent(): Promise<string> {
    return (await prisma.agent.create({ data: { name: "Test Agent" } })).id;
  }

  it("inserts a row and reads it back", async () => {
    const agentId = await createAgent();
    const created = await prisma.agentMarketplace.create({
      data: {
        agentId,
        name: "shipwright",
        source: "github:app-vitals/shipwright",
      },
    });
    const found = await prisma.agentMarketplace.findUnique({
      where: { id: created.id },
    });
    expect(found?.agentId).toBe(agentId);
    expect(found?.name).toBe("shipwright");
    expect(found?.source).toBe("github:app-vitals/shipwright");
    expect(found?.ref).toBeNull();
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (agentId, name)", async () => {
    const agentId = await createAgent();
    await prisma.agentMarketplace.create({
      data: { agentId, name: "dup", source: "a" },
    });
    await expect(
      (async () =>
        prisma.agentMarketplace.create({
          data: { agentId, name: "dup", source: "b", ref: "main" },
        }))(),
    ).rejects.toThrow();
  });

  it("cascades when the agent is deleted", async () => {
    const agentId = await createAgent();
    await prisma.agentMarketplace.create({
      data: { agentId, name: "m1", source: "a" },
    });
    await prisma.agentMarketplace.create({
      data: { agentId, name: "m2", source: "b", ref: "v1" },
    });
    await prisma.agent.delete({ where: { id: agentId } });
    expect(await prisma.agentMarketplace.count({ where: { agentId } })).toBe(0);
  });
});
