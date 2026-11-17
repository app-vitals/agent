/**
 * admin/src/template-seed.integration.test.ts
 * TMK-3.2: applying SHIPWRIGHT_TEMPLATE_SEED to the deployment-wide template
 * (apply, removal, unset, empty lists, invalid seed, concurrency, edits being
 * overwritten) and the fan-out into agent rows and the config bundle, against
 * real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AGENT_PLATFORM_PLUGIN } from "@app-vitals/agent-lib/default-plugins";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentMarketplaceService } from "./agent-marketplaces.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentTemplateReconcileService } from "./agent-template-reconcile.ts";
import { AgentTemplateService } from "./agent-templates.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentService } from "./agents.ts";
import { parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type { SpecialtyType } from "./specialty-types.ts";
import { runTemplateSeed } from "./template-seed.ts";
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

const SEED = {
  marketplaces: [
    { name: "example-plugins", source: "example-org/plugins", ref: "v1.2.0" },
  ],
  plugins: ["some-plugin@example-plugins", "other-plugin@example-plugins"],
};

describeOrSkip("template seed (integration)", () => {
  let prisma: PrismaClient;
  let templates: AgentTemplateService;
  const crypto = makeStrictTokenCrypto(KEY);
  if (!crypto) throw new Error("test crypto");

  const serviceFor = (client: PrismaClient) =>
    new AgentTemplateService(
      client,
      crypto,
      registry,
      new AgentTemplateReconcileService(client, crypto, registry),
    );

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
    templates = serviceFor(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function quietLogger() {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
      logs,
      errors,
      logger: {
        log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
        error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
      },
    };
  }

  const seed = (raw: unknown, service = templates) => {
    const { logger, errors, logs } = quietLogger();
    return runTemplateSeed({
      raw: raw === undefined ? undefined : JSON.stringify(raw),
      templateService: service,
      logger,
    }).then((outcome) => ({ outcome, errors, logs }));
  };

  const mkAgent = (name: string, data: Record<string, unknown> = {}) =>
    prisma.agent.create({ data: { name, specialty: "specialist", ...data } });

  const templateItems = () =>
    prisma.agentTemplateItem.findMany({
      orderBy: [{ kind: "asc" }, { key: "asc" }],
      select: { kind: true, key: true, managedBy: true, payload: true },
    });

  // Reconcile always adds the default platform plugin; these tests only check
  // seeded rows, so it is excluded here.
  const pluginNames = async (agentId: string) =>
    (
      await prisma.agentPlugin.findMany({
        where: { agentId, name: { not: AGENT_PLATFORM_PLUGIN } },
        orderBy: { name: "asc" },
      })
    ).map((p) => ({ name: p.name, source: p.source }));

  it("creates helm-managed deployment-wide items and fans them out to attached agents and their config bundle", async () => {
    const agent = await mkAgent("follower");
    const detached = await mkAgent("detached", { templateDetached: true });

    const { outcome, errors } = await seed(SEED);
    expect(errors).toEqual([]);
    expect(outcome.status).toBe("applied");

    const template = await prisma.agentTemplate.findFirstOrThrow({
      where: { accountId: null, specialty: null },
    });
    expect(template).toBeDefined();
    expect(await templateItems()).toEqual([
      {
        kind: "marketplace",
        key: "example-plugins",
        managedBy: "helm",
        payload: { source: "example-org/plugins", ref: "v1.2.0" },
      },
      {
        kind: "plugin",
        key: "other-plugin@example-plugins",
        managedBy: "helm",
        payload: {},
      },
      {
        kind: "plugin",
        key: "some-plugin@example-plugins",
        managedBy: "helm",
        payload: {},
      },
    ]);

    // The template service view (what the editor and API read) carries it.
    const [view] = await templates.list({ kind: "admin" });
    expect(view?.items.every((i) => i.managedBy === "helm")).toBe(true);

    // Fan-out: the attached agent has the rows, the detached one none.
    expect(
      await prisma.agentMarketplace.findMany({
        where: { agentId: agent.id },
        select: { name: true, source: true, ref: true, rowSource: true },
      }),
    ).toEqual([
      {
        name: "example-plugins",
        source: "example-org/plugins",
        ref: "v1.2.0",
        rowSource: "template",
      },
    ]);
    expect(await pluginNames(agent.id)).toEqual([
      { name: "other-plugin@example-plugins", source: "template" },
      { name: "some-plugin@example-plugins", source: "template" },
    ]);
    expect(
      await prisma.agentMarketplace.count({ where: { agentId: detached.id } }),
    ).toBe(0);
    expect(await pluginNames(detached.id)).toEqual([]);

    // ...and they reach GET /agents/:id/config.
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
    const res = await runtimeApp.request(`/${agent.id}/config`, {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as {
      marketplaces: { name: string; source: string; ref: string | null }[];
      plugins: { plugin: string; marketplace: string }[];
    };
    expect(cfg.marketplaces).toEqual([
      { name: "example-plugins", source: "example-org/plugins", ref: "v1.2.0" },
    ]);
    expect(cfg.plugins).toContainEqual({
      plugin: "some-plugin",
      marketplace: "example-plugins",
    });
    expect(cfg.plugins).toContainEqual({
      plugin: "other-plugin",
      marketplace: "example-plugins",
    });
  });

  it("re-applying a seed that drops a plugin deletes that item and its agent rows, keeping hand-added items", async () => {
    const agent = await mkAgent("follower");
    await seed(SEED);
    // A hand-added template item (managedBy null).
    const [template] = await templates.list({ kind: "admin" });
    await templates.putItem({ kind: "admin" }, template?.id as string, {
      kind: "plugin",
      key: "manual@example-plugins",
    });

    const { outcome } = await seed({
      ...SEED,
      plugins: ["some-plugin@example-plugins"],
    });
    expect(outcome.status === "applied" && outcome.result.deleted).toBe(1);

    expect(
      (await templateItems()).map((i) => [i.kind, i.key, i.managedBy]),
    ).toEqual([
      ["marketplace", "example-plugins", "helm"],
      ["plugin", "manual@example-plugins", null],
      ["plugin", "some-plugin@example-plugins", "helm"],
    ]);
    expect(await pluginNames(agent.id)).toEqual([
      { name: "manual@example-plugins", source: "template" },
      { name: "some-plugin@example-plugins", source: "template" },
    ]);
  });

  it("an unset or blank seed changes nothing", async () => {
    await seed(SEED);
    const before = await templateItems();

    const unset = await seed(undefined);
    expect(unset.outcome.status).toBe("unset");
    const blank = await runTemplateSeed({
      raw: "  ",
      templateService: templates,
      logger: quietLogger().logger,
    });
    expect(blank.status).toBe("unset");

    expect(await templateItems()).toEqual(before);
  });

  it("empty lists clear the seeded items; an absent key leaves its kind alone; hand-added items stay", async () => {
    const agent = await mkAgent("follower");
    await seed(SEED);
    const [template] = await templates.list({ kind: "admin" });
    await templates.putItem({ kind: "admin" }, template?.id as string, {
      kind: "tool",
      key: "Grep",
    });

    // plugins: [] clears the seeded plugins; marketplaces is absent.
    await seed({ plugins: [] });
    expect(
      (await templateItems()).map((i) => [i.kind, i.key, i.managedBy]),
    ).toEqual([
      ["marketplace", "example-plugins", "helm"],
      ["tool", "Grep", null],
    ]);
    expect(await pluginNames(agent.id)).toEqual([]);

    await seed({ marketplaces: [], plugins: [] });
    expect(
      (await templateItems()).map((i) => [i.kind, i.key, i.managedBy]),
    ).toEqual([["tool", "Grep", null]]);
    expect(
      await prisma.agentMarketplace.count({ where: { agentId: agent.id } }),
    ).toBe(0);
  });

  it("never takes over a hand-added item that holds a seeded key", async () => {
    await templates.replace({ kind: "admin" }, {}, [
      {
        kind: "marketplace",
        key: "example-plugins",
        payload: { source: "example-org/fork" },
      },
    ]);
    const { outcome, logs } = await seed(SEED);
    expect(outcome.status === "applied" && outcome.result.skipped).toEqual([
      { kind: "marketplace", key: "example-plugins" },
    ]);
    expect(logs.join("\n")).toContain("marketplace:example-plugins");
    const mk = (await templateItems()).find((i) => i.kind === "marketplace");
    expect(mk).toEqual({
      kind: "marketplace",
      key: "example-plugins",
      managedBy: null,
      payload: { source: "example-org/fork" },
    });
  });

  it("seeded items stay editable, keep their owner, and are overwritten on the next apply", async () => {
    await seed(SEED);
    const [template] = await templates.list({ kind: "admin" });
    const id = template?.id as string;
    await templates.putItem({ kind: "admin" }, id, {
      kind: "marketplace",
      key: "example-plugins",
      payload: { source: "example-org/plugins", ref: "edited" },
    });
    // A full replace keeps the owner of a surviving key too.
    const current = (await templates.get({ kind: "admin" }, id)).items;
    await templates.replace(
      { kind: "admin" },
      {},
      current.map(({ kind, key, payload }) => ({ kind, key, payload })),
    );
    let mk = (await templateItems()).find((i) => i.kind === "marketplace");
    expect(mk).toMatchObject({
      managedBy: "helm",
      payload: { source: "example-org/plugins", ref: "edited" },
    });

    const { outcome } = await seed(SEED);
    expect(outcome.status === "applied" && outcome.result.updated).toBe(1);
    mk = (await templateItems()).find((i) => i.kind === "marketplace");
    expect(mk).toMatchObject({
      managedBy: "helm",
      payload: { source: "example-org/plugins", ref: "v1.2.0" },
    });

    // Re-applying the same seed is a no-op on the rows.
    const again = await seed(SEED);
    expect(again.outcome.status === "applied" && again.outcome.result).toEqual({
      templateId: id,
      created: 0,
      updated: 0,
      unchanged: 3,
      deleted: 0,
      skipped: [],
    });
  });

  it("an invalid seed logs one error naming the entry and writes nothing", async () => {
    await seed(SEED);
    const before = await templateItems();

    const { outcome, errors } = await seed({
      marketplaces: [
        { name: "example-plugins", source: "example-org/plugins" },
        { name: "evil", source: "--upload-pack=touch /tmp/x" },
      ],
      plugins: [],
    });
    expect(outcome.status).toBe("invalid");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("marketplaces[1] (evil)");
    expect(await templateItems()).toEqual(before);

    const bad = await runTemplateSeed({
      raw: "{oops",
      templateService: templates,
      logger: quietLogger().logger,
    });
    expect(bad.status).toBe("invalid");
    expect(await templateItems()).toEqual(before);
  });

  it("two concurrent applications against one database leave exactly one template and one copy of each item", async () => {
    const other = createAdminPrismaClient(TEST_DB as string);
    try {
      const [a, b] = await Promise.all([
        seed(SEED, templates),
        seed(SEED, serviceFor(other)),
      ]);
      expect(a.outcome.status).toBe("applied");
      expect(b.outcome.status).toBe("applied");
      expect(
        await prisma.agentTemplate.count({
          where: { accountId: null, specialty: null },
        }),
      ).toBe(1);
      const items = await templateItems();
      expect(items.map((i) => `${i.kind}:${i.key}`)).toEqual([
        "marketplace:example-plugins",
        "plugin:other-plugin@example-plugins",
        "plugin:some-plugin@example-plugins",
      ]);
    } finally {
      await other.$disconnect();
    }
  });
});
