/**
 * admin/src/agent-template-triggers.integration.test.ts
 * ATP-2.2: template fan-out on change, detach/reattach, reset-to-template and
 * the /agents/{id}/template/* routes, against real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentMarketplaceService } from "./agent-marketplaces.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTemplateReconcileService } from "./agent-template-reconcile.ts";
import { AgentTemplateService } from "./agent-templates.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentService } from "./agents.ts";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type { SpecialtyType } from "./specialty-types.ts";
import { makeStrictTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const KEY = "ab".repeat(32);
const TYPE: SpecialtyType = {
  name: "specialist",
  displayName: "Specialist",
  templatesDir: "workspace/",
  tools: ["Read"],
  requiredEnv: [],
};
const registry = {
  getType: () => TYPE,
  tryGetType: (s: string) => (s === TYPE.name ? TYPE : undefined),
  listTypes: () => [{ name: TYPE.name, displayName: TYPE.displayName }],
};
const admin = { Authorization: "Bearer tok-admin" };

describeOrSkip("agent template triggers (integration)", () => {
  let prisma: PrismaClient;
  let engine: AgentTemplateReconcileService;
  let templates: AgentTemplateService;
  const crypto = makeStrictTokenCrypto(KEY);
  if (!crypto) throw new Error("test crypto");

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentMarketplace.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    engine = new AgentTemplateReconcileService(prisma, crypto, registry);
    templates = new AgentTemplateService(prisma, crypto, registry, engine);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  const mkAgent = (name: string, data: Record<string, unknown> = {}) =>
    prisma.agent.create({ data: { name, specialty: "specialist", ...data } });

  const envOf = async (agentId: string, key: string) => {
    const row = await prisma.agentEnv.findUnique({
      where: { agentId_key: { agentId, key } },
    });
    return row
      ? { value: crypto.decrypt(row.value), source: row.source }
      : null;
  };

  describe("fan-out on template change", () => {
    it("updates template-sourced rows on following agents, skips detached ones and leaves custom rows alone", async () => {
      const follower = await mkAgent("follower");
      const custom = await mkAgent("custom");
      const detached = await mkAgent("detached", { templateDetached: true });
      await prisma.agentEnv.create({
        data: {
          agentId: custom.id,
          key: "FLAG",
          value: crypto.encrypt("mine"),
          source: "custom",
        },
      });

      await templates.replace({ kind: "admin" }, {}, [
        { kind: "env", key: "FLAG", payload: { value: "v1" } },
        { kind: "tool", key: "Grep" },
      ]);
      expect(await envOf(follower.id, "FLAG")).toEqual({
        value: "v1",
        source: "template",
      });
      expect(await envOf(custom.id, "FLAG")).toEqual({
        value: "mine",
        source: "custom",
      });
      expect(await envOf(detached.id, "FLAG")).toBeNull();
      expect(
        await prisma.agentTool.count({ where: { agentId: detached.id } }),
      ).toBe(0);

      // An edit of the template propagates again.
      await templates.replace({ kind: "admin" }, {}, [
        { kind: "env", key: "FLAG", payload: { value: "v2" } },
      ]);
      expect(await envOf(follower.id, "FLAG")).toEqual({
        value: "v2",
        source: "template",
      });
      expect(await envOf(custom.id, "FLAG")).toEqual({
        value: "mine",
        source: "custom",
      });
      expect(await envOf(detached.id, "FLAG")).toBeNull();
      // Grep left the template, so the follower's template-sourced row is gone.
      const grep = await prisma.agentTool.count({
        where: { agentId: follower.id, pattern: "Grep" },
      });
      expect(grep).toBe(0);
    });

    it("scopes fan-out: an account template touches only that account, a specialty template only that type", async () => {
      const acct = await prisma.account.create({
        data: { name: "A", status: "active", maxAgents: 5 },
      });
      const inAcct = await mkAgent("in", { accountId: acct.id });
      const outside = await mkAgent("out");

      await templates.replace({ kind: "account", accountId: acct.id }, {}, [
        { kind: "env", key: "ACCT", payload: { value: "1" } },
      ]);
      expect(await envOf(inAcct.id, "ACCT")).not.toBeNull();
      expect(await envOf(outside.id, "ACCT")).toBeNull();

      await templates.replace({ kind: "admin" }, { specialty: "specialist" }, [
        { kind: "env", key: "TYPED", payload: { value: "1" } },
      ]);
      expect(await envOf(inAcct.id, "TYPED")).not.toBeNull();
      expect(await envOf(outside.id, "TYPED")).not.toBeNull();
    });

    it("item edits and template deletion fan out too", async () => {
      const agent = await mkAgent("a");
      const { template } = await templates.replace({ kind: "admin" }, {}, []);
      await templates.putItem({ kind: "admin" }, template.id, {
        kind: "env",
        key: "K",
        payload: { value: "1" },
      });
      expect(await envOf(agent.id, "K")).toEqual({
        value: "1",
        source: "template",
      });

      await templates.deleteItem({ kind: "admin" }, template.id, "env", "K");
      expect(await envOf(agent.id, "K")).toBeNull();

      await templates.putItem({ kind: "admin" }, template.id, {
        kind: "env",
        key: "K",
        payload: { value: "1" },
      });
      await templates.delete({ kind: "admin" }, template.id);
      expect(await envOf(agent.id, "K")).toBeNull();
    });

    it("one failing agent does not block the rest, and the template write still succeeds", async () => {
      const bad = await mkAgent("bad", { specialty: "specialist" });
      const good = await mkAgent("good");
      const realReconcile = engine.reconcile.bind(engine);
      engine.reconcile = async (id, tx) => {
        if (id === bad.id) throw new Error("boom");
        return realReconcile(id, tx);
      };
      const originalError = console.error;
      console.error = () => {};
      try {
        await templates.replace({ kind: "admin" }, {}, [
          { kind: "env", key: "K", payload: { value: "1" } },
        ]);
      } finally {
        console.error = originalError;
      }
      expect(await envOf(good.id, "K")).not.toBeNull();
      expect(await prisma.agentTemplate.count()).toBe(1);
    });
  });

  describe("reset to template", () => {
    it("drops custom overrides and tombstones for template keys, restoring template rows", async () => {
      const agent = await mkAgent("a");
      await templates.replace({ kind: "admin" }, {}, [
        { kind: "env", key: "A", payload: { value: "tpl" } },
        { kind: "env", key: "B", payload: { value: "tpl" } },
        { kind: "tool", key: "Grep" },
      ]);
      await new AgentEnvService(prisma, crypto).patch(agent.id, {
        A: "edited",
      });
      await new AgentToolService(prisma).remove(
        agent.id,
        (
          await prisma.agentTool.findFirstOrThrow({
            where: { agentId: agent.id, pattern: "Grep" },
          })
        ).id,
      );
      await prisma.agentEnv.create({
        data: { agentId: agent.id, key: "OWN", value: crypto.encrypt("x") },
      });
      expect(await envOf(agent.id, "A")).toEqual({
        value: "edited",
        source: "custom",
      });

      await engine.reset(agent.id, { kind: "env", key: "A" });
      expect(await envOf(agent.id, "A")).toEqual({
        value: "tpl",
        source: "template",
      });
      // Not the targeted key: the tombstone is still there.
      expect(
        (
          await prisma.agentTool.findFirst({
            where: { agentId: agent.id, pattern: "Grep" },
          })
        )?.enabled,
      ).toBe(false);

      await engine.reset(agent.id);
      expect(
        (
          await prisma.agentTool.findFirst({
            where: { agentId: agent.id, pattern: "Grep" },
          })
        )?.source,
      ).toBe("template");
      // Keys the template does not define are untouched.
      expect(await envOf(agent.id, "OWN")).toEqual({
        value: "x",
        source: "custom",
      });
    });

    it("refuses a detached agent", async () => {
      const agent = await mkAgent("a", { templateDetached: true });
      await expect(engine.reset(agent.id)).rejects.toThrow(/detached/);
    });
  });

  describe("/agents/{id}/template routes", () => {
    let app: ReturnType<typeof createAdminApp>;

    beforeEach(() => {
      app = createAdminApp({
        agentService: new AgentService(prisma, registry as never),
        agentEnvService: new AgentEnvService(prisma, crypto),
        agentCronJobService: new AgentCronJobService(prisma),
        agentToolService: new AgentToolService(prisma),
        agentTokenService: new AgentTokenService(prisma),
        agentPluginService: new AgentPluginService(prisma),
        agentMemberService: new AgentMemberService(prisma),
        specialtyRegistry: registry as never,
        agentTemplateReconcileService: engine,
        prisma,
        provisioner: new NoopAgentProvisioner(),
        sessionSecret: "test-admin-session-secret-32-bytes!",
        adminApiKeys: parseAdminApiKeys("root:tok-admin:*"),
      } as unknown as AdminDeps);
    });

    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { ...admin, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    it("reconcile applies the template; detach stops it; reattach resumes; reset restores", async () => {
      const agent = await mkAgent("a", { templateDetached: true });
      await prisma.agentTemplate
        .create({ data: { accountId: null, specialty: null } })
        .then((t) =>
          prisma.agentTemplateItem.create({
            data: {
              templateId: t.id,
              kind: "env",
              key: "K",
              payload: { value: crypto.encrypt("1") },
            },
          }),
        );

      let res = await post(`/agents/${agent.id}/template/reconcile`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe(
        "detached",
      );
      expect(await envOf(agent.id, "K")).toBeNull();

      res = await post(`/agents/${agent.id}/template/reattach`);
      expect(res.status).toBe(200);
      expect(await envOf(agent.id, "K")).toEqual({
        value: "1",
        source: "template",
      });

      await new AgentEnvService(prisma, crypto).patch(agent.id, { K: "mine" });
      res = await post(`/agents/${agent.id}/template/reset`, {
        kind: "env",
        key: "K",
      });
      expect(res.status).toBe(200);
      expect(await envOf(agent.id, "K")).toEqual({
        value: "1",
        source: "template",
      });

      res = await post(`/agents/${agent.id}/template/detach`);
      expect(await res.json()).toEqual({ templateDetached: true });
      expect(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } }))
          .templateDetached,
      ).toBe(true);
      res = await post(`/agents/${agent.id}/template/reset`, {});
      expect(res.status).toBe(409);
    });

    it("404s for an unknown agent", async () => {
      expect((await post("/agents/nope/template/reconcile")).status).toBe(404);
      expect((await post("/agents/nope/template/detach")).status).toBe(404);
    });

    it("POST /agents with templateDetached:true and env creates a detached agent with the explicit env", async () => {
      const res = await post("/agents", {
        name: "viaapi",
        specialty: "specialist",
        templateDetached: true,
        env: { MINE: "1" },
      });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      expect(
        (await prisma.agent.findUniqueOrThrow({ where: { id } }))
          .templateDetached,
      ).toBe(true);
      expect(await envOf(id, "MINE")).toEqual({ value: "1", source: "custom" });
    });
  });

  describe("template marketplaces in the config bundle", () => {
    it("fans a marketplace plus its plugin out to agents in scope and into GET /agents/:id/config", async () => {
      const agent = await mkAgent("a");
      const other = await mkAgent("detached", { templateDetached: true });
      const tokens = new AgentTokenService(prisma);
      const { rawToken } = await tokens.create(agent.id);
      const runtimeApp = createAgentRuntimeApp({
        agentEnvService: { getConfigBundle: async () => null },
        agentCronJobService: { list: async () => [] },
        agentService: new AgentService(prisma),
        agentPluginService: new AgentPluginService(prisma),
        agentMarketplaceService: new AgentMarketplaceService(prisma),
        sessionSecret: "test-admin-session-secret-32-bytes!",
        adminApiKeys: parseAdminApiKeys("root:tok-admin:*"),
        agentTokenService: tokens,
      } as never);
      const config = async () => {
        const res = await runtimeApp.request(`/${agent.id}/config`, {
          headers: { Authorization: `Bearer ${rawToken}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          marketplaces: { name: string; source: string; ref: string | null }[];
          plugins: { name: string }[];
        };
      };

      await templates.replace({ kind: "admin" }, {}, [
        {
          kind: "marketplace",
          key: "example-mk",
          payload: { source: "example-org/plugins", ref: "v1" },
        },
        { kind: "plugin", key: "tool@example-mk" },
      ]);
      let cfg = await config();
      expect(cfg.marketplaces).toEqual([
        { name: "example-mk", source: "example-org/plugins", ref: "v1" },
      ]);
      expect(cfg.plugins.map((p) => p.name)).toContain("tool@example-mk");
      expect(
        await prisma.agentMarketplace.count({ where: { agentId: other.id } }),
      ).toBe(0);

      // Editing the template fans out again.
      await templates.replace({ kind: "admin" }, {}, [
        {
          kind: "marketplace",
          key: "example-mk",
          payload: { source: "example-org/plugins", ref: "v2" },
        },
        { kind: "plugin", key: "tool@example-mk" },
      ]);
      cfg = await config();
      expect(cfg.marketplaces[0]?.ref).toBe("v2");
    });
  });
});
