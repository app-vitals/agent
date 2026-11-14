/**
 * admin/src/agent-template-reconcile.integration.test.ts
 * ATP-2.1: the per-agent template reconcile against real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AGENT_PLATFORM_PLUGIN } from "@app-vitals/agent-lib/default-plugins";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  type AgentTemplateItemKind,
  sealTemplateItemPayload,
  type TemplateItemPayload,
} from "./agent-template-items.ts";
import { AgentTemplateReconcileService } from "./agent-template-reconcile.ts";
import { NotFoundError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type { SpecialtyDefaultsResolver } from "./specialty-defaults.ts";
import { SPECIALIST_TYPE } from "./specialty-types.ts";
import { makeStrictTokenCrypto, type TokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const KEY = "ab".repeat(32);

/** A fixture extension specialty with one tool, one plugin, one system cron. */
const FIXTURE = "fixture";
/** An extension specialty that declares no tools at all. */
const TOOLLESS = "toolless";

const fixtureDefaults: SpecialtyDefaultsResolver = (specialty) => {
  if (specialty === FIXTURE) {
    return {
      tools: ["Read"],
      plugins: ["fx@m"],
      crons: [{ name: "fx-loop", schedule: "*/5 * * * *", prompt: "/fx" }],
    };
  }
  if (specialty === TOOLLESS) return { tools: [], plugins: [], crons: [] };
  return undefined;
};

const registry = {
  tryGetType: (s: string) =>
    s === SPECIALIST_TYPE.name ? SPECIALIST_TYPE : undefined,
};

type Item = {
  kind: AgentTemplateItemKind;
  key: string;
  payload?: TemplateItemPayload;
};

describeOrSkip("AgentTemplateReconcileService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentTemplateReconcileService;
  const realCrypto = makeStrictTokenCrypto(KEY);
  if (!realCrypto) throw new Error("test crypto");
  const crypto: TokenCrypto = realCrypto;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentTemplateItem.deleteMany();
    await prisma.agentTemplate.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    service = new AgentTemplateReconcileService(
      prisma,
      crypto,
      registry,
      fixtureDefaults,
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  async function template(
    accountId: string | null,
    specialty: string | null,
    items: Item[],
  ): Promise<string> {
    const t = await prisma.agentTemplate.create({
      data: { accountId, specialty },
    });
    await setItems(t.id, items);
    return t.id;
  }

  async function setItems(templateId: string, items: Item[]): Promise<void> {
    await prisma.agentTemplateItem.deleteMany({ where: { templateId } });
    for (const it of items) {
      await prisma.agentTemplateItem.create({
        data: {
          templateId,
          kind: it.kind,
          key: it.key,
          payload: sealTemplateItemPayload(it.kind, it.payload ?? {}, crypto),
        },
      });
    }
  }

  async function agent(
    opts: {
      specialty?: string;
      accountId?: string | null;
      templateDetached?: boolean;
    } = {},
  ): Promise<string> {
    const a = await prisma.agent.create({
      data: {
        name: `agent-${Math.random().toString(36).slice(2)}`,
        specialty: opts.specialty ?? FIXTURE,
        accountId: opts.accountId ?? null,
        templateDetached: opts.templateDetached ?? false,
      },
    });
    return a.id;
  }

  async function account(name = "Acme"): Promise<string> {
    return (await prisma.account.create({ data: { name } })).id;
  }

  async function env(agentId: string): Promise<Record<string, string>> {
    const rows = await prisma.agentEnv.findMany({ where: { agentId } });
    return Object.fromEntries(
      rows.map((r) => [r.key, `${crypto.decrypt(r.value)}|${r.source}`]),
    );
  }

  async function plugin(agentId: string, name: string) {
    return prisma.agentPlugin.findUnique({
      where: { agentId_name: { agentId, name } },
    });
  }

  async function snapshot(agentId: string) {
    const [envs, tools, plugins, crons] = await Promise.all([
      prisma.agentEnv.findMany({ where: { agentId }, orderBy: { key: "asc" } }),
      prisma.agentTool.findMany({
        where: { agentId },
        orderBy: { pattern: "asc" },
      }),
      prisma.agentPlugin.findMany({
        where: { agentId },
        orderBy: { name: "asc" },
      }),
      prisma.agentCronJob.findMany({
        where: { agentId },
        orderBy: { id: "asc" },
      }),
    ]);
    return { envs, tools, plugins, crons };
  }

  // ─── precedence ───────────────────────────────────────────────────────────

  it("the most specific of all five layers wins for a key defined in several", async () => {
    const acct = await account();
    const other = await account("Other");
    const agentId = await agent({ accountId: acct });
    // "fx@m" is a built-in default of FIXTURE (layer 0, version null).
    const layerIds = {
      deployment: await template(null, null, [
        { kind: "plugin", key: "fx@m", payload: { version: "1" } },
        { kind: "env", key: "LEVEL", payload: { value: "deployment" } },
      ]),
      deploymentType: await template(null, FIXTURE, [
        { kind: "plugin", key: "fx@m", payload: { version: "2" } },
        { kind: "env", key: "LEVEL", payload: { value: "deployment-type" } },
      ]),
      account: await template(acct, null, [
        { kind: "plugin", key: "fx@m", payload: { version: "3" } },
        { kind: "env", key: "LEVEL", payload: { value: "account" } },
      ]),
      accountType: await template(acct, FIXTURE, [
        { kind: "plugin", key: "fx@m", payload: { version: "4" } },
        { kind: "env", key: "LEVEL", payload: { value: "account-type" } },
      ]),
    };
    // Templates outside the agent's scope never apply.
    await template(other, FIXTURE, [
      { kind: "plugin", key: "fx@m", payload: { version: "other-account" } },
    ]);
    await template(null, "specialist", [
      { kind: "plugin", key: "fx@m", payload: { version: "other-type" } },
    ]);

    await service.reconcile(agentId);
    expect((await plugin(agentId, "fx@m"))?.version).toBe("4");
    expect((await env(agentId)).LEVEL).toBe("account-type|template");

    const expected = [
      [layerIds.accountType, "3", "account"],
      [layerIds.account, "2", "deployment-type"],
      [layerIds.deploymentType, "1", "deployment"],
    ] as const;
    for (const [drop, version, level] of expected) {
      await prisma.agentTemplate.delete({ where: { id: drop } });
      await service.reconcile(agentId);
      const row = await plugin(agentId, "fx@m");
      expect(row?.version).toBe(version);
      expect(row?.source).toBe("template");
      expect((await env(agentId)).LEVEL).toBe(`${level}|template`);
    }

    // Only the specialty default is left: the plugin stays (version null),
    // the env key, defined by no layer any more, is removed.
    await prisma.agentTemplate.delete({ where: { id: layerIds.deployment } });
    await service.reconcile(agentId);
    expect((await plugin(agentId, "fx@m"))?.version).toBeNull();
    expect((await env(agentId)).LEVEL).toBeUndefined();
  });

  // ─── add / track / remove ─────────────────────────────────────────────────

  it("adds every missing item, including the specialty defaults, as template rows", async () => {
    const agentId = await agent();
    await template(null, null, [
      { kind: "env", key: "SENTRY_DSN", payload: { value: "dsn" } },
      { kind: "env", key: "API_SECRET", payload: { value: "s", secret: true } },
      { kind: "tool", key: "Write" },
      { kind: "plugin", key: "x@y", payload: { version: "1.2.3" } },
      {
        kind: "cron",
        key: "digest",
        payload: {
          schedule: "0 9 * * *",
          prompt: "/digest",
          channel: "C1",
        },
      },
    ]);

    const result = await service.reconcile(agentId);
    expect(result.status).toBe("reconciled");
    expect(result.counts.env.created).toBe(2);
    expect(result.counts.tool.created).toBe(2); // Read (default) + Write
    expect(result.counts.plugin.created).toBe(3); // platform + fx@m + x@y
    expect(result.counts.cron.created).toBe(1);
    expect(result.systemCrons.created).toBe(1);

    expect(await env(agentId)).toEqual({
      SENTRY_DSN: "dsn|template",
      API_SECRET: "s|template",
    });
    const secretRow = await prisma.agentEnv.findUniqueOrThrow({
      where: { agentId_key: { agentId, key: "API_SECRET" } },
    });
    expect(secretRow.secret).toBe(true);
    expect(secretRow.value).not.toBe("s"); // encrypted at rest

    const { tools, plugins, crons } = await snapshot(agentId);
    expect(tools.map((t) => [t.pattern, t.enabled, t.source])).toEqual([
      ["Read", true, "template"],
      ["Write", true, "template"],
    ]);
    expect(plugins.map((p) => [p.name, p.version, p.source])).toEqual([
      [AGENT_PLATFORM_PLUGIN, null, "template"],
      ["fx@m", null, "template"],
      ["x@y", "1.2.3", "template"],
    ]);
    const digest = crons.find((c) => c.name === "digest");
    expect(digest).toMatchObject({
      schedule: "0 9 * * *",
      prompt: "/digest",
      channel: "C1",
      user: null,
      silent: false,
      enabled: true,
      system: false,
      source: "template",
    });
    const loop = crons.find((c) => c.name === "fx-loop");
    expect(loop?.system).toBe(true);
  });

  it("template rows track edits in place and are removed when the template drops them", async () => {
    const agentId = await agent();
    const t = await template(null, null, [
      { kind: "env", key: "A", payload: { value: "1" } },
      { kind: "tool", key: "Write" },
      { kind: "plugin", key: "x@y", payload: { version: "1" } },
      {
        kind: "cron",
        key: "digest",
        payload: { schedule: "0 9 * * *", prompt: "/d", silent: true },
      },
    ]);
    await service.reconcile(agentId);
    const before = await snapshot(agentId);

    await setItems(t, [
      { kind: "env", key: "A", payload: { value: "2", secret: true } },
      { kind: "tool", key: "Write", payload: { enabled: false } },
      { kind: "plugin", key: "x@y", payload: { version: "2" } },
      {
        kind: "cron",
        key: "digest",
        payload: { schedule: "0 10 * * *", prompt: "/d2", silent: true },
      },
    ]);
    const edited = await service.reconcile(agentId);
    expect(edited.counts.env.updated).toBe(1);
    expect(edited.counts.tool.updated).toBe(1);
    expect(edited.counts.plugin.updated).toBe(1);
    expect(edited.counts.cron.updated).toBe(1);

    const after = await snapshot(agentId);
    const envRow = after.envs.find((e) => e.key === "A");
    expect(envRow?.id).toBe(before.envs.find((e) => e.key === "A")?.id);
    expect(crypto.decrypt(envRow?.value ?? "")).toBe("2");
    expect(envRow?.secret).toBe(true);
    expect(after.tools.find((x) => x.pattern === "Write")?.enabled).toBe(false);
    expect(after.plugins.find((p) => p.name === "x@y")?.version).toBe("2");
    const digest = after.crons.find((c) => c.name === "digest");
    expect(digest?.id).toBe(before.crons.find((c) => c.name === "digest")?.id);
    expect(digest).toMatchObject({ schedule: "0 10 * * *", prompt: "/d2" });

    await setItems(t, []);
    const removed = await service.reconcile(agentId);
    expect(removed.counts.env.deleted).toBe(1);
    expect(removed.counts.tool.deleted).toBe(1);
    expect(removed.counts.plugin.deleted).toBe(1);
    expect(removed.counts.cron.deleted).toBe(1);
    const final = await snapshot(agentId);
    expect(final.envs).toEqual([]);
    expect(final.tools.map((x) => x.pattern)).toEqual(["Read"]);
    expect(final.plugins.map((p) => p.name).sort()).toEqual(
      [AGENT_PLATFORM_PLUGIN, "fx@m"].sort(),
    );
    expect(final.crons.map((c) => c.name)).toEqual(["fx-loop"]);
  });

  // ─── custom rows, tombstones, detached ────────────────────────────────────

  it("never modifies or removes custom rows", async () => {
    const agentId = await agent();
    await prisma.agentEnv.create({
      data: { agentId, key: "A", value: crypto.encrypt("mine") },
    });
    await prisma.agentEnv.create({
      data: { agentId, key: "ONLY_MINE", value: crypto.encrypt("x") },
    });
    await prisma.agentTool.create({ data: { agentId, pattern: "Custom" } });
    await prisma.agentPlugin.create({
      data: { agentId, name: "x@y", version: "mine" },
    });
    await prisma.agentCronJob.create({
      data: { agentId, schedule: "0 1 * * *", prompt: "mine", silent: true },
    });
    await template(null, null, [
      { kind: "env", key: "A", payload: { value: "template" } },
      { kind: "plugin", key: "x@y", payload: { version: "template" } },
    ]);
    const before = await snapshot(agentId);

    await service.reconcile(agentId);
    const after = await snapshot(agentId);
    for (const row of before.envs) {
      expect(after.envs.find((e) => e.id === row.id)).toEqual(row);
    }
    expect(after.tools.find((t) => t.pattern === "Custom")).toEqual(
      before.tools[0],
    );
    expect(after.plugins.find((p) => p.name === "x@y")).toEqual(
      before.plugins[0],
    );
    expect(after.crons.find((c) => c.prompt === "mine")).toEqual(
      before.crons[0],
    );
  });

  it("honors tombstones: a disabled custom row is neither re-added, re-enabled nor adopted", async () => {
    const agentId = await agent();
    // Tombstones as ATP-1.2 writes them (enabled=false, source=custom); the
    // env tombstone even holds the template's exact value.
    await prisma.agentEnv.create({
      data: {
        agentId,
        key: "A",
        value: crypto.encrypt("v"),
        enabled: false,
      },
    });
    await prisma.agentTool.create({
      data: { agentId, pattern: "Write", enabled: false },
    });
    await prisma.agentPlugin.create({
      data: { agentId, name: "x@y", enabled: false },
    });
    await prisma.agentCronJob.create({
      data: {
        agentId,
        name: "digest",
        schedule: "0 9 * * *",
        prompt: "/d",
        enabled: false,
      },
    });
    await template(null, null, [
      { kind: "env", key: "A", payload: { value: "v" } },
      { kind: "tool", key: "Write" },
      { kind: "plugin", key: "x@y" },
      {
        kind: "cron",
        key: "digest",
        payload: { schedule: "0 9 * * *", prompt: "/d" },
      },
    ]);
    const before = await snapshot(agentId);

    const result = await service.reconcile(agentId);
    const after = await snapshot(agentId);
    expect(after.envs).toEqual(before.envs);
    expect(after.tools.find((t) => t.pattern === "Write")).toEqual(
      before.tools[0],
    );
    expect(after.plugins.find((p) => p.name === "x@y")).toEqual(
      before.plugins[0],
    );
    expect(after.crons.filter((c) => c.name === "digest")).toEqual(
      before.crons,
    );
    for (const kind of ["env", "tool", "plugin", "cron"] as const) {
      expect(result.counts[kind].adopted).toBe(0);
    }
  });

  it("never touches a detached agent", async () => {
    const agentId = await agent({ templateDetached: true });
    await prisma.agentEnv.create({
      data: {
        agentId,
        key: "OLD",
        value: crypto.encrypt("x"),
        source: "template",
      },
    });
    await template(null, null, [
      { kind: "env", key: "A", payload: { value: "v" } },
      { kind: "tool", key: "Write" },
    ]);
    const before = await snapshot(agentId);

    const result = await service.reconcile(agentId);
    expect(result.status).toBe("detached");
    expect(await snapshot(agentId)).toEqual(before);
  });

  // ─── adoption ─────────────────────────────────────────────────────────────

  it("adopts custom rows whose value already equals the template value", async () => {
    const agentId = await agent();
    const envRow = await prisma.agentEnv.create({
      data: { agentId, key: "A", value: crypto.encrypt("v") },
    });
    await prisma.agentEnv.create({
      data: { agentId, key: "B", value: crypto.encrypt("different") },
    });
    // Seeded at create time as custom (pre-ATP rows): the specialty default.
    const toolRow = await prisma.agentTool.create({
      data: { agentId, pattern: "Read" },
    });
    const pluginRow = await prisma.agentPlugin.create({
      data: { agentId, name: "x@y", version: "1" },
    });
    await template(null, null, [
      { kind: "env", key: "A", payload: { value: "v" } },
      { kind: "env", key: "B", payload: { value: "template" } },
      { kind: "plugin", key: "x@y", payload: { version: "1" } },
    ]);

    const result = await service.reconcile(agentId);
    expect(result.counts.env.adopted).toBe(1);
    expect(result.counts.tool.adopted).toBe(1);
    expect(result.counts.plugin.adopted).toBe(1);
    const after = await snapshot(agentId);
    expect(after.envs.find((e) => e.key === "A")).toMatchObject({
      id: envRow.id,
      source: "template",
    });
    expect(after.envs.find((e) => e.key === "B")?.source).toBe("custom");
    expect(after.tools.find((t) => t.pattern === "Read")).toMatchObject({
      id: toolRow.id,
      source: "template",
    });
    expect(after.plugins.find((p) => p.name === "x@y")).toMatchObject({
      id: pluginRow.id,
      source: "template",
    });
  });

  it("adopts a same-named user cron only when schedule and prompt match; otherwise leaves it and reports it", async () => {
    const agentId = await agent();
    const match = await prisma.agentCronJob.create({
      data: {
        agentId,
        name: "same",
        schedule: "0 9 * * *",
        prompt: "/same",
        channel: "C-mine",
      },
    });
    const differs = await prisma.agentCronJob.create({
      data: {
        agentId,
        name: "differs",
        schedule: "0 9 * * *",
        prompt: "/mine",
        channel: "C-mine",
      },
    });
    await template(null, null, [
      {
        kind: "cron",
        key: "same",
        payload: { schedule: "0 9 * * *", prompt: "/same", silent: true },
      },
      {
        kind: "cron",
        key: "differs",
        payload: { schedule: "0 9 * * *", prompt: "/template", silent: true },
      },
    ]);

    const result = await service.reconcile(agentId);
    expect(result.counts.cron.adopted).toBe(1);
    expect(result.counts.cron.created).toBe(0);
    expect(result.conflicts).toEqual([
      { kind: "cron", key: "differs", reason: "cron_name_conflict" },
    ]);

    const crons = await prisma.agentCronJob.findMany({
      where: { agentId, system: false },
    });
    expect(crons).toHaveLength(2);
    // Adopted: same row, now template-owned, template fields applied, fields
    // the template does not set (the delivery target) kept.
    expect(crons.find((c) => c.id === match.id)).toMatchObject({
      source: "template",
      silent: true,
      channel: "C-mine",
    });
    expect(crons.find((c) => c.id === differs.id)).toEqual(differs);
  });

  // ─── tools floor ──────────────────────────────────────────────────────────

  it("never reduces allowedTools to empty", async () => {
    const agentId = await agent({ specialty: TOOLLESS });
    const t = await template(null, null, [{ kind: "tool", key: "Write" }]);
    await service.reconcile(agentId);
    expect(
      (await prisma.agentTool.findMany({ where: { agentId } })).map(
        (x) => x.pattern,
      ),
    ).toEqual(["Write"]);

    // Removing the only tool would leave the agent with none: kept.
    await setItems(t, []);
    const removed = await service.reconcile(agentId);
    expect(removed.toolsEmptyGuarded).toBe(true);
    expect(removed.counts.tool.deleted).toBe(0);
    const kept = await prisma.agentTool.findMany({ where: { agentId } });
    expect(kept.map((x) => [x.pattern, x.enabled])).toEqual([["Write", true]]);

    // Disabling the only tool is refused the same way.
    await setItems(t, [
      { kind: "tool", key: "Write", payload: { enabled: false } },
    ]);
    const disabled = await service.reconcile(agentId);
    expect(disabled.toolsEmptyGuarded).toBe(true);
    expect(
      (await prisma.agentTool.findFirstOrThrow({ where: { agentId } })).enabled,
    ).toBe(true);

    // With another enabled tool present the removal goes through.
    await prisma.agentTool.create({ data: { agentId, pattern: "Custom" } });
    await setItems(t, []);
    const ok = await service.reconcile(agentId);
    expect(ok.toolsEmptyGuarded).toBe(false);
    expect(ok.counts.tool.deleted).toBe(1);
  });

  // ─── specialty change ─────────────────────────────────────────────────────

  it("re-resolves when the agent's specialty changed", async () => {
    const agentId = await agent({ specialty: FIXTURE });
    await template(null, FIXTURE, [
      { kind: "env", key: "FIXTURE_ONLY", payload: { value: "f" } },
    ]);
    await template(null, "specialist", [
      { kind: "env", key: "SPECIALIST_ONLY", payload: { value: "s" } },
    ]);
    await service.reconcile(agentId);
    expect(await env(agentId)).toEqual({ FIXTURE_ONLY: "f|template" });

    await prisma.agent.update({
      where: { id: agentId },
      data: { specialty: "specialist" },
    });
    await service.reconcile(agentId);
    expect(await env(agentId)).toEqual({ SPECIALIST_ONLY: "s|template" });
    const { tools, plugins, crons } = await snapshot(agentId);
    expect(tools.map((t) => t.pattern).sort()).toEqual(
      [...SPECIALIST_TYPE.tools].sort(),
    );
    expect(plugins.map((p) => p.name)).toEqual([AGENT_PLATFORM_PLUGIN]);
    expect(crons).toEqual([]); // fx-loop was FIXTURE's system cron
  });

  it("a template cron named like a specialty system cron overrides it in place", async () => {
    const agentId = await agent();
    await service.reconcile(agentId);
    const loop = await prisma.agentCronJob.findFirstOrThrow({
      where: { agentId, name: "fx-loop" },
    });

    await template(null, null, [
      {
        kind: "cron",
        key: "fx-loop",
        payload: { schedule: "0 * * * *", prompt: "/fx-template" },
      },
    ]);
    await service.reconcile(agentId);
    const rows = await prisma.agentCronJob.findMany({ where: { agentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: loop.id,
      system: true,
      schedule: "0 * * * *",
      prompt: "/fx-template",
    });
  });

  // ─── idempotency and atomicity ────────────────────────────────────────────

  it("is idempotent: a second reconcile writes nothing", async () => {
    const acct = await account();
    const agentId = await agent({ accountId: acct });
    await template(null, null, [
      { kind: "env", key: "A", payload: { value: "1", secret: true } },
      { kind: "tool", key: "Write" },
      { kind: "plugin", key: "x@y", payload: { version: "1" } },
      {
        kind: "cron",
        key: "digest",
        payload: { schedule: "0 9 * * *", prompt: "/d", channel: "C1" },
      },
    ]);
    await template(acct, FIXTURE, [
      { kind: "env", key: "B", payload: { value: "2" } },
    ]);
    await service.reconcile(agentId);
    const before = await snapshot(agentId);

    const second = await service.reconcile(agentId);
    for (const kind of ["env", "tool", "plugin", "cron"] as const) {
      expect(second.counts[kind]).toEqual({
        created: 0,
        updated: 0,
        adopted: 0,
        deleted: 0,
      });
    }
    const after = await snapshot(agentId);
    expect(after.envs).toEqual(before.envs);
    expect(after.tools).toEqual(before.tools);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.crons.filter((c) => !c.system)).toEqual(
      before.crons.filter((c) => !c.system),
    );
  });

  it("writes nothing when the reconcile fails part-way (one transaction)", async () => {
    const agentId = await agent();
    await prisma.agentTool.create({
      data: { agentId, pattern: "Stale", source: "template" },
    });
    await prisma.agentTool.create({ data: { agentId, pattern: "Custom" } });
    await template(null, null, [
      { kind: "tool", key: "Write" },
      { kind: "plugin", key: "x@y" },
      {
        kind: "cron",
        key: "digest",
        payload: { schedule: "0 9 * * *", prompt: "/d" },
      },
      { kind: "env", key: "A", payload: { value: "v" } },
    ]);
    const before = await snapshot(agentId);

    // Env rows are written last; an encrypt failure there must roll back the
    // tool, plugin and cron writes made before it.
    const failing = new AgentTemplateReconcileService(
      prisma,
      {
        encrypt: () => {
          throw new Error("boom");
        },
        decrypt: (s) => crypto.decrypt(s),
      },
      registry,
      fixtureDefaults,
    );
    await expect(failing.reconcile(agentId)).rejects.toThrow("boom");
    expect(await snapshot(agentId)).toEqual(before);
  });

  // ─── guards ───────────────────────────────────────────────────────────────

  it("an unknown specialty changes nothing", async () => {
    const agentId = await agent({ specialty: "renamed-type" });
    await prisma.agentTool.create({
      data: { agentId, pattern: "Read", source: "template" },
    });
    await template(null, null, [{ kind: "tool", key: "Write" }]);
    const before = await snapshot(agentId);

    const result = await service.reconcile(agentId);
    expect(result.status).toBe("unknown_specialty");
    expect(await snapshot(agentId)).toEqual(before);
  });

  it("skips and reports a per-agent credential key that reached a template", async () => {
    const agentId = await agent();
    // Bypasses the service-layer denylist (ATP-1.3) on purpose.
    await template(null, null, [
      { kind: "env", key: "GH_TOKEN", payload: { value: "leak" } },
    ]);
    const result = await service.reconcile(agentId);
    expect(await env(agentId)).toEqual({});
    expect(result.conflicts).toEqual([
      { kind: "env", key: "GH_TOKEN", reason: "denylisted_env_key" },
    ]);
  });

  it("throws NotFoundError for an unknown agent", async () => {
    await expect(service.reconcile("missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
