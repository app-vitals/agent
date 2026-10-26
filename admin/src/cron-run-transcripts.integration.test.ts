/**
 * admin/src/cron-run-transcripts.integration.test.ts
 * Round-trip and retention sweep against a real Postgres (COS-43.1).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentService } from "./agents.ts";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import {
  CronRunTranscriptService,
  TRANSCRIPT_RETENTION_PER_AGENT,
} from "./cron-run-transcripts.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { parseTranscriptConfig } from "./transcript-config.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ADMIN = "admin-key";

describeOrSkip("cron-run transcripts (integration)", () => {
  let prisma: PrismaClient;
  let agentId: string;
  let otherAgentId: string;
  let cronId: string;
  let otherCronId: string;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentTranscriptRead.deleteMany();
    await prisma.agentCronRunTranscript.deleteMany();
    agentId = (await prisma.agent.create({ data: { name: "TxA" } })).id;
    otherAgentId = (await prisma.agent.create({ data: { name: "TxB" } })).id;
    cronId = (
      await prisma.agentCronJob.create({
        data: { agentId, name: "c", schedule: "* * * * *", prompt: "p" },
      })
    ).id;
    otherCronId = (
      await prisma.agentCronJob.create({
        data: {
          agentId: otherAgentId,
          name: "c",
          schedule: "* * * * *",
          prompt: "p",
        },
      })
    ).id;
  });

  afterEach(async () => {
    await prisma.agentTranscriptRead.deleteMany();
    await prisma.agentCronRunTranscript.deleteMany();
    await prisma.agent.deleteMany({
      where: { id: { in: [agentId, otherAgentId] } },
    });
    await prisma.$disconnect();
  });

  function makeApp() {
    const deps = {
      agentService: new AgentService(prisma),
      agentTokenService: { validate: async () => null },
      adminApiKeys: parseAdminApiKeys(`root:${ADMIN}:*`),
      sessionSecret: "s".repeat(32),
      prisma,
      transcripts: {
        config: parseTranscriptConfig({
          SHIPWRIGHT_TRANSCRIPT_API_ENABLED: "enabled",
        }),
        store: new CronRunTranscriptService(prisma),
      },
    } as unknown as AdminDeps;
    return createAdminApp(deps);
  }

  const newRun = (agent: string, cron: string, startedAt = new Date()) =>
    prisma.agentCronRun.create({
      data: { agentId: agent, cronId: cron, startedAt },
    });

  const put = (
    app: ReturnType<typeof createAdminApp>,
    runId: string,
    body: string,
    cron = cronId,
    agent = agentId,
  ) =>
    app.request(`/agents/${agent}/crons/${cron}/runs/${runId}/transcript`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN}`,
      },
      body: JSON.stringify({
        sessionId: "s",
        body,
        truncated: false,
        redactions: 1,
      }),
    });

  it("round-trips PUT then GET and writes an audit row", async () => {
    const app = makeApp();
    const run = await newRun(agentId, cronId);
    expect((await put(app, run.id, "hello\n")).status).toBe(200);
    const res = await app.request(
      `/agents/${agentId}/crons/${cronId}/runs/${run.id}/transcript`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      runId: run.id,
      cronId,
      sessionId: "s",
      bytes: 6,
      truncated: false,
      redactions: 1,
      body: "hello\n",
    });
    const reads = await prisma.agentTranscriptRead.findMany();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      runId: run.id,
      agentId,
      scopeKind: "admin",
    });
  });

  it("upserts: a second PUT replaces the body, one row per run", async () => {
    const app = makeApp();
    const run = await newRun(agentId, cronId);
    await put(app, run.id, "one");
    await put(app, run.id, "two-two");
    const rows = await prisma.agentCronRunTranscript.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("two-two");
    expect(rows[0]?.bytes).toBe(7);
  });

  it("404s a run owned by a different agent or cron", async () => {
    const app = makeApp();
    const run = await newRun(otherAgentId, otherCronId);
    expect((await put(app, run.id, "x")).status).toBe(404);
    const mine = await newRun(agentId, cronId);
    expect((await put(app, mine.id, "x", otherCronId)).status).toBe(404);
    expect(await prisma.agentCronRunTranscript.count()).toBe(0);
  });

  it(`keeps only the newest ${TRANSCRIPT_RETENTION_PER_AGENT} per agent`, async () => {
    const service = new CronRunTranscriptService(prisma);
    const total = TRANSCRIPT_RETENTION_PER_AGENT + 5;
    const base = Date.now() - total * 1000;
    const runs: Array<{ id: string }> = [];
    for (let i = 0; i < total; i++) {
      runs.push(await newRun(agentId, cronId, new Date(base + i)));
    }
    for (const [i, run] of runs.entries()) {
      await prisma.agentCronRunTranscript.create({
        data: {
          runId: run.id,
          agentId,
          cronId,
          bytes: 1,
          truncated: false,
          redactions: 0,
          body: "x",
          createdAt: new Date(base + i * 10),
        },
      });
    }
    const otherRun = await newRun(otherAgentId, otherCronId);
    await prisma.agentCronRunTranscript.create({
      data: {
        runId: otherRun.id,
        agentId: otherAgentId,
        cronId: otherCronId,
        bytes: 1,
        truncated: false,
        redactions: 0,
        body: "x",
        createdAt: new Date(base),
      },
    });

    const fresh = await newRun(agentId, cronId);
    await service.upsert({
      runId: fresh.id,
      agentId,
      cronId,
      sessionId: null,
      bytes: 1,
      truncated: false,
      redactions: 0,
      body: "new",
    });

    const mine = await prisma.agentCronRunTranscript.findMany({
      where: { agentId },
      orderBy: { createdAt: "desc" },
    });
    expect(mine).toHaveLength(TRANSCRIPT_RETENTION_PER_AGENT);
    expect(mine[0]?.runId).toBe(fresh.id);
    // The oldest were dropped; the other agent's row is untouched.
    expect(mine.some((r) => r.runId === runs[0]?.id)).toBe(false);
    expect(
      await prisma.agentCronRunTranscript.count({
        where: { agentId: otherAgentId },
      }),
    ).toBe(1);
  });
});
