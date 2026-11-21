/**
 * Integration: githubLookup.listRepositories over a real repo cache. Requires
 * DATABASE_URL_ADMIN_TEST; skips otherwise. A throwing fetch proves no GitHub
 * call is made.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createGithubLookupService } from "./github-enterprise-api.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NOW = new Date("2026-11-20T12:00:00Z");
const key = (org: string) => ({
  accountId: "acct",
  appKind: "lookup" as const,
  appRef: "555",
  org,
});

describeOrSkip("githubLookup.listRepositories (cache, integration)", () => {
  let prisma: PrismaClient;
  let cache: GitHubRepoCacheService;
  const realFetch = globalThis.fetch;

  const svc = () =>
    createGithubLookupService({
      appService: {
        get: async (role: string) =>
          role === "lookup" ? { appId: "555", enterpriseSlug: null } : null,
        getPrivateKey: async (role: string) =>
          role === "lookup" ? "pem" : null,
      } as unknown as GitHubEnterpriseAppService,
      cache,
      now: () => NOW,
    });

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    cache = new GitHubRepoCacheService(prisma, { now: () => NOW });
    globalThis.fetch = (() => {
      throw new Error("GitHub must not be called");
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  });

  it("cold start returns an empty syncing result", async () => {
    expect(await svc().listRepositories("acct")).toEqual({
      configured: true,
      repos: [],
      syncState: "syncing",
    });
  });

  it("serves a partial crawl with progress, then a completed one as ready", async () => {
    const snap = await cache.upsertSnapshot(key("acme"), {
      crawlPage: 1,
      crawlStartedAt: NOW,
      totalCount: 2,
    });
    await cache.upsertRepos(snap.id, [{ githubId: 1, fullName: "acme/a" }]);
    const partial = await svc().listRepositories("acct");
    expect(partial.syncState).toBe("syncing");
    expect(partial.repos).toEqual([{ fullName: "acme/a", archived: false }]);
    expect(partial.progress).toEqual({ reposSeen: 1, totalCount: 2 });

    await cache.upsertRepos(snap.id, [
      { githubId: 2, fullName: "acme/b", archived: true },
    ]);
    await cache.upsertSnapshot(key("acme"), { completedAt: NOW });
    const done = await svc().listRepositories("acct");
    expect(done.syncState).toBe("ready");
    expect(done.repos).toHaveLength(2);
    expect(done.fetchedAt).toEqual(NOW);
  });
});
