/**
 * admin/src/agent-marketplaces-api.integration.test.ts
 * Integration tests for AgentMarketplaceService, the /agents/{id}/marketplaces
 * routes and the `marketplaces` field of GET /agents/{id}/config, against a
 * real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentMarketplaceService } from "./agent-marketplaces.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentService } from "./agents.ts";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_KEY = "admin-key-token";

describeOrSkip("AgentMarketplaceService + routes (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentMarketplaceService;
  let tokens: AgentTokenService;
  let adminApp: ReturnType<typeof createAdminApp>;
  let runtimeApp: ReturnType<typeof createAgentRuntimeApp>;
  let agentA: string;
  let agentB: string;
  let tokenA: string;
  let tokenB: string;

  const adminKeys = parseAdminApiKeys(`root:${ADMIN_KEY}:*`);
  const json = (token: string, body?: unknown, method = "POST") => ({
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const get = (token: string) => ({
    headers: { Authorization: `Bearer ${token}` },
  });

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentMarketplace.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();

    agentA = (await prisma.agent.create({ data: { name: "A" } })).id;
    agentB = (await prisma.agent.create({ data: { name: "B" } })).id;
    service = new AgentMarketplaceService(prisma);
    tokens = new AgentTokenService(prisma);
    tokenA = (await tokens.create(agentA)).rawToken;
    tokenB = (await tokens.create(agentB)).rawToken;

    adminApp = createAdminApp({
      agentTokenService: tokens,
      agentMemberService: { exists: async () => false },
      agentMarketplaceService: service,
      prisma,
      sessionSecret: SESSION_SECRET,
      adminApiKeys: adminKeys,
    } as unknown as AdminDeps);

    runtimeApp = createAgentRuntimeApp({
      agentEnvService: { getConfigBundle: async () => null },
      agentCronJobService: { list: async () => [] },
      agentService: new AgentService(prisma),
      agentPluginService: { listEnabled: async () => [] },
      agentMarketplaceService: service,
      sessionSecret: SESSION_SECRET,
      adminApiKeys: adminKeys,
      agentTokenService: tokens,
    } as never);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe("service", () => {
    it("upserts, lists in creation order, and re-points an existing name", async () => {
      const first = await service.upsert(agentA, {
        name: "shipwright",
        source: "app-vitals/shipwright",
      });
      expect(first.ref).toBeNull();
      await service.upsert(agentA, {
        name: "other",
        source: "https://github.com/o/r.git",
        ref: "v1",
      });
      const again = await service.upsert(agentA, {
        name: "shipwright",
        source: "app-vitals/shipwright-fork",
        ref: "main",
      });
      expect(again.id).toBe(first.id);

      const rows = await service.list(agentA);
      expect(rows.map((r) => r.name)).toEqual(["shipwright", "other"]);
      expect(rows[0]?.source).toBe("app-vitals/shipwright-fork");
      expect(rows[0]?.ref).toBe("main");
      expect(await service.list(agentB)).toEqual([]);
    });

    it("same name on two agents are independent rows", async () => {
      await service.upsert(agentA, { name: "m", source: "o/a" });
      await service.upsert(agentB, { name: "m", source: "o/b" });
      expect((await service.list(agentA))[0]?.source).toBe("o/a");
      expect((await service.list(agentB))[0]?.source).toBe("o/b");
    });

    it("rejects an invalid source without writing", async () => {
      await expect(
        service.upsert(agentA, { name: "m", source: "http://x.com/o/r" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityError);
      expect(await service.list(agentA)).toEqual([]);
    });

    it("remove deletes an owned row and 404s on another agent's row", async () => {
      const row = await service.upsert(agentA, { name: "m", source: "o/r" });
      await expect(service.remove(agentB, row.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await service.list(agentA)).toHaveLength(1);
      await service.remove(agentA, row.id);
      expect(await service.list(agentA)).toEqual([]);
      await expect(service.remove(agentA, row.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("routes", () => {
    it("POST upserts (201), GET lists, DELETE removes (204)", async () => {
      const created = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        json(tokenA, {
          name: "shipwright",
          source: "app-vitals/shipwright",
          ref: "main",
        }),
      );
      expect(created.status).toBe(201);
      const { marketplace } = await created.json();
      expect(marketplace).toMatchObject({
        agentId: agentA,
        name: "shipwright",
        source: "app-vitals/shipwright",
        ref: "main",
      });

      const listed = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        get(ADMIN_KEY),
      );
      expect(listed.status).toBe(200);
      expect((await listed.json()).marketplaces).toHaveLength(1);

      const del = await adminApp.request(
        `/agents/${agentA}/marketplaces/${marketplace.id}`,
        json(tokenA, undefined, "DELETE"),
      );
      expect(del.status).toBe(204);
      expect(await service.list(agentA)).toEqual([]);
    });

    it("platform admin key can write and read any agent", async () => {
      const res = await adminApp.request(
        `/agents/${agentB}/marketplaces`,
        json(ADMIN_KEY, { name: "m", source: "o/r" }),
      );
      expect(res.status).toBe(201);
    });

    it("invalid source returns 422 and writes nothing", async () => {
      for (const source of [
        "http://x.com/o/r",
        "not-a-source",
        "git@github.com:o/r.git",
        "",
      ]) {
        const res = await adminApp.request(
          `/agents/${agentA}/marketplaces`,
          json(tokenA, { name: "m", source }),
        );
        expect(res.status).toBe(422);
      }
      expect(await service.list(agentA)).toEqual([]);
    });

    it("deleting another agent's row returns 404 and leaves it", async () => {
      const row = await service.upsert(agentB, { name: "m", source: "o/r" });
      const res = await adminApp.request(
        `/agents/${agentA}/marketplaces/${row.id}`,
        json(tokenA, undefined, "DELETE"),
      );
      expect(res.status).toBe(404);
      expect(await service.list(agentB)).toHaveLength(1);
    });

    it("another agent's key is 403 on every method; no credential is 401", async () => {
      const row = await service.upsert(agentA, { name: "m", source: "o/r" });
      const post = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        json(tokenB, { name: "x", source: "o/r" }),
      );
      const list = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        get(tokenB),
      );
      const del = await adminApp.request(
        `/agents/${agentA}/marketplaces/${row.id}`,
        json(tokenB, undefined, "DELETE"),
      );
      expect([post.status, list.status, del.status]).toEqual([403, 403, 403]);
      expect(
        (await adminApp.request(`/agents/${agentA}/marketplaces`)).status,
      ).toBe(401);
      expect(await service.list(agentA)).toHaveLength(1);
    });
  });

  describe("row source and tombstones (TMK-2.1)", () => {
    const seedTemplate = (agentId: string, name = "tpl") =>
      prisma.agentMarketplace.create({
        data: {
          agentId,
          name,
          source: "o/r",
          rowSource: "template",
          enabled: true,
        },
      });

    it("upsert writes custom/enabled and overrides a template row", async () => {
      const tpl = await seedTemplate(agentA);
      const res = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        json(tokenA, { name: "tpl", source: "o/other" }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()).marketplace;
      expect(body.rowSource).toBe("custom");
      expect(body.enabled).toBe(true);
      const row = await prisma.agentMarketplace.findUnique({
        where: { id: tpl.id },
      });
      expect(row?.rowSource).toBe("custom");
      expect(row?.source).toBe("o/other");
    });

    it("DELETE tombstones a template row and removes a custom row", async () => {
      const tpl = await seedTemplate(agentA);
      const custom = await service.upsert(agentA, {
        name: "mine",
        source: "o/m",
      });
      for (const id of [tpl.id, custom.id]) {
        const res = await adminApp.request(
          `/agents/${agentA}/marketplaces/${id}`,
          json(tokenA, undefined, "DELETE"),
        );
        expect(res.status).toBe(204);
      }
      const tomb = await prisma.agentMarketplace.findUnique({
        where: { id: tpl.id },
      });
      expect(tomb?.enabled).toBe(false);
      expect(tomb?.rowSource).toBe("custom");
      expect(
        await prisma.agentMarketplace.findUnique({ where: { id: custom.id } }),
      ).toBeNull();
    });

    it("addFromTemplate creates a template row, refreshes it, and leaves custom rows alone", async () => {
      const created = await service.addFromTemplate(agentA, {
        name: "tpl",
        source: "o/r",
        ref: "v1",
      });
      expect(created.rowSource).toBe("template");
      expect(created.enabled).toBe(true);
      const refreshed = await service.addFromTemplate(agentA, {
        name: "tpl",
        source: "o/r2",
        ref: null,
      });
      expect(refreshed.id).toBe(created.id);
      expect(refreshed.source).toBe("o/r2");
      expect(refreshed.rowSource).toBe("template");

      const custom = await service.upsert(agentA, {
        name: "mine",
        source: "o/m",
      });
      const untouched = await service.addFromTemplate(agentA, {
        name: "mine",
        source: "o/x",
      });
      expect(untouched.source).toBe("o/m");
      expect(untouched.rowSource).toBe("custom");
      expect(untouched.id).toBe(custom.id);
    });

    it("addFromTemplate validates input like upsert", async () => {
      await expect(
        (async () =>
          service.addFromTemplate(agentA, { name: "m", source: "../etc" }))(),
      ).rejects.toThrow(UnprocessableEntityError);
    });

    it("GET lists rowSource/enabled and the config bundle omits tombstones", async () => {
      const tpl = await seedTemplate(agentA, "gone");
      await service.upsert(agentA, { name: "kept", source: "o/k" });
      await adminApp.request(
        `/agents/${agentA}/marketplaces/${tpl.id}`,
        json(tokenA, undefined, "DELETE"),
      );
      const list = await adminApp.request(
        `/agents/${agentA}/marketplaces`,
        get(tokenA),
      );
      const rows = (await list.json()).marketplaces;
      expect(rows.map((r: { enabled: boolean }) => r.enabled).sort()).toEqual([
        false,
        true,
      ]);
      const cfg = await runtimeApp.request(`/${agentA}/config`, get(tokenA));
      expect((await cfg.json()).marketplaces).toEqual([
        { name: "kept", source: "o/k", ref: null },
      ]);
    });
  });

  describe("GET /agents/:id/config", () => {
    it("includes marketplaces: [] when none", async () => {
      const res = await runtimeApp.request(`/${agentA}/config`, get(tokenA));
      expect(res.status).toBe(200);
      expect((await res.json()).marketplaces).toEqual([]);
    });

    it("includes name/source/ref for the agent's own rows only", async () => {
      await service.upsert(agentA, { name: "one", source: "o/r", ref: "v1" });
      await service.upsert(agentA, {
        name: "two",
        source: "https://h.example/o/r",
      });
      await service.upsert(agentB, { name: "theirs", source: "o/x" });
      const res = await runtimeApp.request(`/${agentA}/config`, get(tokenA));
      expect(res.status).toBe(200);
      expect((await res.json()).marketplaces).toEqual([
        { name: "one", source: "o/r", ref: "v1" },
        { name: "two", source: "https://h.example/o/r", ref: null },
      ]);
    });
  });
});
