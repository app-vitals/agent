/**
 * admin/src/agent-ask.integration.test.ts
 * POST /agents/{id}/ask writes an AgentAsk audit row to a real Postgres and
 * GET /agents/{id}/asks reads it back (COS-31.1). The chat service is an
 * in-memory fake; only the audit store is real.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentAskService } from "./agent-ask.ts";
import { parseAgentAskConfig } from "./agent-ask-config.ts";
import { AgentService } from "./agents.ts";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ADMIN = "admin-key";
const READ = "platform-read-key";
const QUESTION = "is the release pipeline green?";

describeOrSkip("agent ask audit (integration)", () => {
  let prisma: PrismaClient;
  let fromId: string;
  let toId: string;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentAsk.deleteMany();
    fromId = (await prisma.agent.create({ data: { name: "Asker" } })).id;
    toId = (await prisma.agent.create({ data: { name: "Answerer" } })).id;
  });

  afterEach(async () => {
    await prisma.agentAsk.deleteMany();
    await prisma.agent.deleteMany({ where: { id: { in: [fromId, toId] } } });
    await prisma.$disconnect();
  });

  function makeApp() {
    let nowMs = Date.parse("2026-10-25T12:00:00.000Z");
    let polls = 0;
    const chatClient = {
      createThread: async (agentId: string) => ({
        id: "thread-int-1",
        agentId,
        title: null,
        memberId: null,
        createdAt: "",
        updatedAt: "",
      }),
      createMessage: async (threadId: string, role: string, body: string) => ({
        id: "msg-user",
        threadId,
        role,
        body,
        createdAt: "",
        claimedBy: null,
        repliedAt: null,
        tokens: null,
        costUsd: null,
        attachmentFilename: null,
        attachmentSize: null,
      }),
      listMessages: async (threadId: string) => {
        polls += 1;
        const base = {
          threadId,
          createdAt: "",
          claimedBy: null,
          tokens: null,
          costUsd: null,
          attachmentFilename: null,
          attachmentSize: null,
        };
        const messages = [
          {
            ...base,
            id: "msg-user",
            role: "user",
            body: QUESTION,
            repliedAt: polls >= 1 ? "2026-10-25T12:00:01.000Z" : null,
          },
          {
            ...base,
            id: "msg-reply",
            role: "assistant",
            body: "green",
            repliedAt: null,
          },
        ];
        return { messages, total: 2, limit: 50, offset: 0 };
      },
    };
    const deps = {
      agentService: new AgentService(prisma),
      agentTokenService: { validate: async () => null },
      agentMemberService: { listByEmail: async () => [] },
      adminApiKeys: parseAdminApiKeys(
        `root:${ADMIN}:*,reader:${READ}:platform.read`,
      ),
      sessionSecret: "s".repeat(32),
      agentAsk: {
        config: parseAgentAskConfig({
          SHIPWRIGHT_AGENT_ASK_ENABLED: "enabled",
          SHIPWRIGHT_AGENT_ASK_ALLOWLIST: `${fromId}>${toId}`,
        }),
        store: new AgentAskService(prisma),
        clock: { now: () => new Date(nowMs) },
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      },
      chatClient,
    } as unknown as AdminDeps;
    return createAdminApp(deps);
  }

  it("writes the AgentAsk row and lists it through GET /agents/{id}/asks", async () => {
    const app = makeApp();
    const res = await app.request(`/agents/${toId}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN}`,
      },
      body: JSON.stringify({ from: fromId, question: QUESTION, waitMs: 2000 }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { askId: string; status: string };
    expect(created.status).toBe("replied");

    const row = await prisma.agentAsk.findUnique({
      where: { id: created.askId },
    });
    expect(row).toMatchObject({
      fromAgentId: fromId,
      toAgentId: toId,
      threadId: "thread-int-1",
      depth: 1,
      waitMs: 2000,
      ttlSeconds: 600,
      status: "replied",
      repliedAt: new Date("2026-10-25T12:00:01.000Z"),
    });
    expect(JSON.stringify(row)).not.toContain(QUESTION);

    for (const agentId of [toId, fromId]) {
      const list = await app.request(`/agents/${agentId}/asks`, {
        headers: { Authorization: `Bearer ${READ}` },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        asks: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.asks[0]).toMatchObject({
        id: created.askId,
        fromAgentId: fromId,
        toAgentId: toId,
        threadId: "thread-int-1",
        status: "replied",
        repliedAt: "2026-10-25T12:00:01.000Z",
      });
    }
  });
});
