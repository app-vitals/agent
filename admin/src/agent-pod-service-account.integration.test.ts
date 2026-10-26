/**
 * admin/src/agent-pod-service-account.integration.test.ts
 * COS-48.1: the Agent.podServiceAccountName column exists, is nullable and is
 * independent of k8sServiceAccountName. Requires DATABASE_URL_ADMIN_TEST;
 * skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("Agent.podServiceAccountName (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("defaults to null for a new agent", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    expect(agent.podServiceAccountName).toBeNull();
  });

  it("round-trips without touching k8sServiceAccountName", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", podServiceAccountName: "agent-a-sa" },
    });
    const row = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(row.podServiceAccountName).toBe("agent-a-sa");
    expect(row.k8sServiceAccountName).toBeNull();
  });
});
