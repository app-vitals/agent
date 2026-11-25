/**
 * admin/src/github-installation-selection.integration.test.ts
 * Real-database test (GIS-1.1): the agent installation crawl records whether
 * the agent App's installation is on "all" or "selected" repositories on the
 * cached snapshot, and listAgentSnapshots exposes it. A missing value stays
 * null (unknown), never "all".
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  type AgentInstallationClient,
  crawlAgentInstallation,
  DEPLOYMENT_WIDE_ACCOUNT_KEY,
} from "./github-agent-installation-crawler.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const T0 = new Date("2026-11-25T12:00:00Z");
const clock = { now: () => new Date(T0) };
const APP_ID = 4242;

type Selection = "all" | "selected" | "none" | undefined;

function client(selection: Selection): AgentInstallationClient {
  return {
    async listOrgInstallations() {
      return [{ id: 900, appId: APP_ID, repositorySelection: selection }];
    },
    async listInstallationRepositoriesPage() {
      return {
        repos: [{ id: 1, fullName: "acme/a" }],
        hasNext: false,
        perPage: 10,
      };
    },
  };
}

describeOrSkip("agent installation repository selection (integration)", () => {
  let prisma: PrismaClient;
  let cache: GitHubRepoCacheService;

  const clean = async () => {
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
  };
  const crawl = (selection: Selection) =>
    crawlAgentInstallation({
      agent: { accountId: null, appId: APP_ID },
      org: "acme",
      client: client(selection),
      store: cache,
      clock,
    });
  const stored = async () =>
    (
      await cache.listAgentSnapshots(DEPLOYMENT_WIDE_ACCOUNT_KEY, String(APP_ID))
    )[0]?.repositorySelection;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    cache = new GitHubRepoCacheService(prisma, clock);
    await clean();
  });
  afterEach(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it("stores 'all', then 'selected' on a later crawl", async () => {
    expect((await crawl("all")).outcome).toBe("complete");
    expect(await stored()).toBe("all");
    await crawl("selected");
    expect(await stored()).toBe("selected");
  });

  it("leaves a missing value null, and resets a previous value to null", async () => {
    await crawl(undefined);
    expect(await stored()).toBeNull();
    await crawl("all");
    expect(await stored()).toBe("all");
    await crawl(undefined);
    expect(await stored()).toBeNull();
  });
});
