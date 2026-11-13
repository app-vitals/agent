/**
 * admin/src/agent-templates.integration.test.ts
 * ATP-1.1: AgentTemplate / AgentTemplateItem schema and the row source
 * markers, against real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  openTemplateItemPayload,
  sealTemplateItemPayload,
  type TemplateItemPayload,
} from "./agent-template-items.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("AgentTemplate schema (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  /** Inserting a second template with the same scope must fail. */
  async function expectDuplicateRejected(
    accountId: string | null,
    specialty: string | null,
  ): Promise<void> {
    await prisma.agentTemplate.create({ data: { accountId, specialty } });
    await expect(
      (async () =>
        prisma.agentTemplate.create({ data: { accountId, specialty } }))(),
    ).rejects.toThrow();
    expect(
      await prisma.agentTemplate.count({ where: { accountId, specialty } }),
    ).toBe(1);
  }

  describe("(accountId, specialty) uniqueness", () => {
    it("rejects a second deployment-wide template for every specialty (both NULL)", async () => {
      await expectDuplicateRejected(null, null);
    });

    it("rejects a second deployment-wide template for one specialty (accountId NULL)", async () => {
      await expectDuplicateRejected(null, "specialist");
    });

    it("rejects a second account template for every specialty (specialty NULL)", async () => {
      const account = await prisma.account.create({ data: { name: "A" } });
      await expectDuplicateRejected(account.id, null);
    });

    it("rejects a second account template for one specialty (both set)", async () => {
      const account = await prisma.account.create({ data: { name: "A" } });
      await expectDuplicateRejected(account.id, "specialist");
    });

    it("allows one template per distinct scope", async () => {
      const a = await prisma.account.create({ data: { name: "A" } });
      const b = await prisma.account.create({ data: { name: "B" } });
      const scopes: Array<[string | null, string | null]> = [
        [null, null],
        [null, "specialist"],
        [null, "coder"],
        [a.id, null],
        [a.id, "specialist"],
        [b.id, null],
        [b.id, "specialist"],
      ];
      for (const [accountId, specialty] of scopes) {
        await prisma.agentTemplate.create({ data: { accountId, specialty } });
      }
      expect(await prisma.agentTemplate.count()).toBe(scopes.length);
    });

    it("rejects a duplicate (templateId, kind, key) item but allows the key under another kind", async () => {
      const t = await prisma.agentTemplate.create({ data: {} });
      await prisma.agentTemplateItem.create({
        data: { templateId: t.id, kind: "tool", key: "Read" },
      });
      await prisma.agentTemplateItem.create({
        data: { templateId: t.id, kind: "plugin", key: "Read" },
      });
      await expect(
        (async () =>
          prisma.agentTemplateItem.create({
            data: { templateId: t.id, kind: "tool", key: "Read" },
          }))(),
      ).rejects.toThrow();
    });

    it("deletes an account's templates and their items with the account", async () => {
      const account = await prisma.account.create({ data: { name: "A" } });
      const t = await prisma.agentTemplate.create({
        data: { accountId: account.id },
      });
      await prisma.agentTemplateItem.create({
        data: { templateId: t.id, kind: "tool", key: "Read" },
      });
      await prisma.account.delete({ where: { id: account.id } });
      expect(await prisma.agentTemplate.count()).toBe(0);
      expect(await prisma.agentTemplateItem.count()).toBe(0);
    });
  });

  describe("column defaults (what pre-existing rows get)", () => {
    // Raw INSERTs that omit the new columns exercise the database DEFAULTs,
    // which is what ADD COLUMN gives rows written before the migration.
    it("source defaults to custom, templateDetached to false, AgentTool.updatedAt to now", async () => {
      await prisma.$executeRaw`INSERT INTO "Agent" ("id", "name", "updatedAt") VALUES ('ag1', 'legacy', now())`;
      await prisma.$executeRaw`INSERT INTO "AgentEnv" ("id", "agentId", "key", "value", "updatedAt") VALUES ('e1', 'ag1', 'K', 'v', now())`;
      await prisma.$executeRaw`INSERT INTO "AgentTool" ("id", "agentId", "pattern") VALUES ('t1', 'ag1', 'Read')`;
      await prisma.$executeRaw`INSERT INTO "AgentPlugin" ("id", "agentId", "name", "updatedAt") VALUES ('p1', 'ag1', 'x@y', now())`;
      await prisma.$executeRaw`INSERT INTO "AgentCronJob" ("id", "agentId", "schedule", "prompt", "updatedAt") VALUES ('c1', 'ag1', '* * * * *', 'hi', now())`;

      const agent = await prisma.agent.findUniqueOrThrow({
        where: { id: "ag1" },
        include: { envVars: true, tools: true, plugins: true, cronJobs: true },
      });
      expect(agent.templateDetached).toBe(false);
      expect(agent.envVars.map((r) => r.source)).toEqual(["custom"]);
      expect(agent.tools.map((r) => r.source)).toEqual(["custom"]);
      expect(agent.plugins.map((r) => r.source)).toEqual(["custom"]);
      expect(agent.cronJobs.map((r) => r.source)).toEqual(["custom"]);
      const tool = agent.tools[0];
      expect(tool?.updatedAt).toBeInstanceOf(Date);
      expect(
        Math.abs((tool?.updatedAt.getTime() ?? 0) - Date.now()),
      ).toBeLessThan(60_000);
    });

    it("keeps an explicit source=template and bumps AgentTool.updatedAt on update", async () => {
      const agent = await prisma.agent.create({ data: { name: "a" } });
      const tool = await prisma.agentTool.create({
        data: { agentId: agent.id, pattern: "Bash", source: "template" },
      });
      expect(tool.source).toBe("template");
      await Bun.sleep(5);
      const updated = await prisma.agentTool.update({
        where: { id: tool.id },
        data: { enabled: false },
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        tool.updatedAt.getTime(),
      );
    });
  });

  describe("env item payload", () => {
    it("stores an env item's value AES-256-GCM encrypted and reads it back", async () => {
      const crypto = makeStrictTokenCrypto("cd".repeat(32));
      if (!crypto) throw new Error("test key rejected");
      const t = await prisma.agentTemplate.create({ data: {} });
      const item = await prisma.agentTemplateItem.create({
        data: {
          templateId: t.id,
          kind: "env",
          key: "API_TOKEN",
          payload: sealTemplateItemPayload(
            "env",
            { value: "plain-secret", secret: true },
            crypto,
          ),
        },
      });

      // The plaintext never reaches the column.
      const rows = await prisma.$queryRaw<
        Array<{ payload: string }>
      >`SELECT "payload"::text AS payload FROM "AgentTemplateItem" WHERE "id" = ${item.id}`;
      expect(rows[0]?.payload).not.toContain("plain-secret");

      const stored = await prisma.agentTemplateItem.findUniqueOrThrow({
        where: { id: item.id },
      });
      const payload = stored.payload as TemplateItemPayload;
      expect(String(payload.value).split(":")).toHaveLength(3);
      expect(openTemplateItemPayload("env", payload, crypto)).toEqual({
        value: "plain-secret",
        secret: true,
      });
    });
  });
});
