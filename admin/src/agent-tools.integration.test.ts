/**
 * agent/src/agent-tools.integration.test.ts
 * Integration tests for AgentToolService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentToolService } from "./agent-tools.ts";
import { NotFoundError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

describeOrSkip("AgentToolService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentToolService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentToolService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("add() creates a new tool pattern", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Read");
    expect(tool.agentId).toBe(agentId);
    expect(tool.pattern).toBe("Read");
    expect(tool.enabled).toBe(true);
  });

  it("add() re-enables a disabled pattern (upsert behavior)", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Write");
    await service.toggle(agentId, tool.id, false);
    // Re-add should re-enable it
    const reenabled = await service.add(agentId, "Write");
    expect(reenabled.enabled).toBe(true);
  });

  it("list() returns all tools for an agent ordered by createdAt", async () => {
    const agentId = await createAgent(prisma);
    await service.add(agentId, "Read");
    await service.add(agentId, "Write");
    await service.add(agentId, "Bash");
    const tools = await service.list(agentId);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.pattern)).toEqual(["Read", "Write", "Bash"]);
  });

  it("remove() deletes a tool pattern", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Bash");
    await service.remove(agentId, tool.id);
    const tools = await service.list(agentId);
    expect(tools).toHaveLength(0);
  });

  it("remove() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(service.remove(agentId, "nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("remove() throws NotFoundError when toolId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const tool = await service.add(agentId1, "Read");
    await expect(service.remove(agentId2, tool.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("toggle() enables and disables a tool", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Write");
    const disabled = await service.toggle(agentId, tool.id, false);
    expect(disabled.enabled).toBe(false);
    const enabled = await service.toggle(agentId, tool.id, true);
    expect(enabled.enabled).toBe(true);
  });

  it("toggle() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.toggle(agentId, "nonexistent", true),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updatePattern() changes the pattern string", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "OldPattern");
    const updated = await service.updatePattern(agentId, tool.id, "NewPattern");
    expect(updated.pattern).toBe("NewPattern");
  });

  it("updatePattern() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.updatePattern(agentId, "nonexistent", "Read"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ─── ATP-1.2: source / tombstones ──────────────────────────────────────────

  it("add() stamps source=custom, including on a template row", async () => {
    const agentId = await createAgent(prisma);
    const fresh = await service.add(agentId, "Read");
    expect(fresh.source).toBe("custom");
    await service.addFromTemplate(agentId, "Bash");
    const edited = await service.add(agentId, "Bash");
    expect(edited.source).toBe("custom");
  });

  it("addFromTemplate() writes source=template and keeps it on re-run", async () => {
    const agentId = await createAgent(prisma);
    const first = await service.addFromTemplate(agentId, "Read");
    expect(first.source).toBe("template");
    expect(first.enabled).toBe(true);
    const again = await service.addFromTemplate(agentId, "Read");
    expect(again.source).toBe("template");
  });

  it("addFromTemplate() does not resurrect a tombstone or reclaim a custom row", async () => {
    const agentId = await createAgent(prisma);
    const t = await service.addFromTemplate(agentId, "Read");
    await service.remove(agentId, t.id);
    const after = await service.addFromTemplate(agentId, "Read");
    expect(after.enabled).toBe(false);
    expect(after.source).toBe("custom");
  });

  it("toggle() and updatePattern() turn a template row custom", async () => {
    const agentId = await createAgent(prisma);
    const a = await service.addFromTemplate(agentId, "Read");
    expect((await service.toggle(agentId, a.id, false)).source).toBe("custom");
    const b = await service.addFromTemplate(agentId, "Bash");
    const updated = await service.updatePattern(agentId, b.id, "Bash(ls)");
    expect(updated.source).toBe("custom");
  });

  it("remove() of a template row leaves a disabled custom tombstone", async () => {
    const agentId = await createAgent(prisma);
    const t = await service.addFromTemplate(agentId, "Read");
    await service.remove(agentId, t.id);
    const rows = await prisma.agentTool.findMany({ where: { agentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.source).toBe("custom");
  });

  it("remove() of a custom row deletes it", async () => {
    const agentId = await createAgent(prisma);
    const t = await service.add(agentId, "Read");
    await service.remove(agentId, t.id);
    expect(await prisma.agentTool.findMany({ where: { agentId } })).toEqual([]);
  });
});
