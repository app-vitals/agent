/**
 * PMK-1.4: integration tests (real Postgres) for the baked-marketplaces store:
 * AgentService.setBakedMarketplaces, overwrite semantics, GET detail exposure,
 * and the absence of any other write path.
 *
 * Requires DATABASE_URL_ADMIN_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentService } from "./agents.ts";
import { PatchAgentBodySchema } from "./openapi-schemas.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("baked marketplaces store (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentGitHubInstallationsSnapshot.deleteMany();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("defaults to an empty list", async () => {
    const { id } = await prisma.agent.create({ data: { name: "a" } });
    expect((await service.getDetail(id))?.bakedMarketplaces).toEqual([]);
  });

  it("stores the reported names and getDetail exposes them", async () => {
    const { id } = await prisma.agent.create({ data: { name: "a" } });
    const stored = await service.setBakedMarketplaces(id, [
      "vitals-os",
      "shipwright",
    ]);
    expect(stored).toEqual(["vitals-os", "shipwright"]);
    expect((await service.getDetail(id))?.bakedMarketplaces).toEqual([
      "vitals-os",
      "shipwright",
    ]);
  });

  it("overwrites on every report instead of appending", async () => {
    const { id } = await prisma.agent.create({ data: { name: "a" } });
    await service.setBakedMarketplaces(id, ["vitals-os", "shipwright"]);
    await service.setBakedMarketplaces(id, ["vitals-os"]);
    expect((await service.getDetail(id))?.bakedMarketplaces).toEqual([
      "vitals-os",
    ]);
    await service.setBakedMarketplaces(id, []);
    expect((await service.getDetail(id))?.bakedMarketplaces).toEqual([]);
  });

  it("only touches the reporting agent's row", async () => {
    const a = await prisma.agent.create({ data: { name: "a" } });
    const b = await prisma.agent.create({ data: { name: "b" } });
    await service.setBakedMarketplaces(a.id, ["x"]);
    expect((await service.getDetail(b.id))?.bakedMarketplaces).toEqual([]);
  });

  it("returns null for an unknown agent", async () => {
    expect(await service.setBakedMarketplaces("nope", ["x"])).toBeNull();
  });

  it("updateSelfHosted (the PATCH writer) never writes the baked list", async () => {
    const { id } = await prisma.agent.create({ data: { name: "a" } });
    await service.setBakedMarketplaces(id, ["vitals-os"]);
    await service.updateSelfHosted(id, {
      selfHosted: true,
      // biome-ignore lint/suspicious/noExplicitAny: proving an off-contract key is ignored
      ...({ bakedMarketplaces: ["evil"] } as any),
    });
    expect((await service.getDetail(id))?.bakedMarketplaces).toEqual([
      "vitals-os",
    ]);
  });

  it("PatchAgentBodySchema does not carry the field through", () => {
    const parsed = PatchAgentBodySchema.safeParse({
      bakedMarketplaces: ["evil"],
    });
    if (parsed.success) {
      expect("bakedMarketplaces" in parsed.data).toBe(false);
    }
  });

  it("no admin source other than the report path writes bakedMarketplaces", () => {
    const dir = import.meta.dir;
    const writers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f))
      .filter((f) =>
        /bakedMarketplaces/.test(readFileSync(join(dir, f), "utf8")),
      )
      .sort();
    // agents.ts: writer + read select; agents-api.ts: report route + read
    // serialization; openapi-schemas.ts: response/read schemas only;
    // admin-ui.ts / admin-ui-pages.ts: read-only display on the agent page
    // (PMK-1.5), no write path.
    expect(writers).toEqual([
      "admin-ui-pages.ts",
      "admin-ui.ts",
      "agents-api.ts",
      "agents.ts",
      "openapi-schemas.ts",
    ]);
    const api = readFileSync(join(dir, "agents-api.ts"), "utf8");
    expect(api.match(/setBakedMarketplaces\(/g)?.length).toBe(1);
  });
});
