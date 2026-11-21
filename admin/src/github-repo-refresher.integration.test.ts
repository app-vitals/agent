/**
 * admin/src/github-repo-refresher.integration.test.ts
 * GithubRepoRefresher against a real PostgreSQL DB through
 * GitHubRepoCacheService: two workers ticking concurrently over the same orgs
 * (the snapshot lease means each org is worked by exactly one of them), plus
 * the crawl engine and access backfill end to end with fake GitHub ports.
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AccessProbe } from "./github-access-backfill.ts";
import {
  GitHubRepoCacheService,
  type SnapshotKey,
} from "./github-repo-cache.ts";
import { crawlRepos, type PageSource } from "./github-repo-crawler.ts";
import {
  GithubRepoRefresher,
  type RefreshTarget,
} from "./github-repo-refresher.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const T0 = new Date("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;
const ORGS = ["acme", "beta", "gamma"];

describeOrSkip("GithubRepoRefresher (integration)", () => {
  let prisma: PrismaClient;
  let now: Date;
  let svc: GitHubRepoCacheService;
  /** "<org>:<page>" per page fetch, across both workers. */
  let fetches: string[];
  let probes: string[];

  const clock = { now: () => new Date(now) };

  /** Three repos per org, two per page, with a small delay per fetch. */
  const source = (org: string): PageSource => ({
    async fetchPage(page) {
      fetches.push(`${org}:${page}`);
      await Bun.sleep(20);
      const ids = [1, 2, 3].slice((page - 1) * 2, page * 2);
      return {
        repos: ids.map((i) => ({
          githubId: org.length * 100 + i,
          fullName: `${org}/r${i}`,
        })),
        totalCount: 3,
        hasNext: page < 2,
      };
    },
  });

  const probe: AccessProbe = {
    async getCollaboratorPermissionWithRateLimit(org, repo, user) {
      probes.push(`${org}/${repo}@${user}`);
      await Bun.sleep(5);
      return {
        role: "write",
        rateLimit: { remaining: 4000, resetAt: null, retryAfterSeconds: null },
      };
    },
  };

  const targets = (): RefreshTarget[] =>
    ORGS.map((org) => {
      const key: SnapshotKey = {
        accountId: "acc",
        appKind: "lookup",
        appRef: "555",
        org,
      };
      const src = source(org);
      return {
        key,
        crawl: (ctx) =>
          crawlRepos({
            key,
            source: src,
            store: svc,
            clock,
            shouldStop: ctx.shouldStop,
          }),
        access: { probe, users: [{ username: "octocat" }] },
      };
    });

  const worker = (holder: string) =>
    new GithubRepoRefresher({
      discovery: { listTargets: async () => targets() },
      store: svc,
      clock,
      holder,
      config: {
        intervalMs: 60_000,
        ttlMs: HOUR,
        stalenessCapMs: 6 * HOUR,
        timeBudgetMs: 45_000,
      },
      log: () => {},
    });

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubRepoAccess.deleteMany();
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    now = T0;
    svc = new GitHubRepoCacheService(prisma, clock);
    fetches = [];
    probes = [];
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("two workers ticking concurrently work each org exactly once", async () => {
    const [a, b] = await Promise.all([
      worker("worker-a").tick(),
      worker("worker-b").tick(),
    ]);

    // Every page fetched once, every pair probed once, across both workers.
    expect([...fetches].sort()).toEqual(
      ORGS.flatMap((o) => [`${o}:1`, `${o}:2`]).sort(),
    );
    expect(probes.length).toBe(ORGS.length * 3);
    expect(new Set(probes).size).toBe(probes.length);

    // Per org: one worker worked it, the other skipped (lease) or found it done.
    for (const org of ORGS) {
      const states = [a, b].map(
        (r) => r.targets.find((t) => t.key.org === org)?.state,
      );
      expect(states.filter((s) => s === "worked")).toHaveLength(1);
    }

    const snaps = await prisma.gitHubRepoSnapshot.findMany();
    expect(snaps).toHaveLength(ORGS.length);
    for (const s of snaps) {
      expect(s.completedAt).not.toBeNull();
      expect(s.leaseHolder).toBeNull();
      expect(s.leasedUntil).toBeNull();
      expect(s.lastTickAt).not.toBeNull();
    }
    expect(await prisma.gitHubCachedRepo.count()).toBe(ORGS.length * 3);
    expect(
      await prisma.gitHubRepoAccess.count({ where: { status: "ok" } }),
    ).toBe(ORGS.length * 3);
  });

  it("an overlapping tick on the same worker is a no-op", async () => {
    const w = worker("worker-a");
    const [first, second] = await Promise.all([w.tick(), w.tick()]);
    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe("overlap");
    expect(fetches.length).toBe(ORGS.length * 2);
  });

  it("a later tick within the TTL is idle; after the TTL it refreshes", async () => {
    await worker("worker-a").tick();
    fetches = [];
    probes = [];
    now = new Date(T0.getTime() + 60_000);
    const idle = await worker("worker-b").tick();
    expect(fetches).toEqual([]);
    expect(idle.targets.every((t) => t.state === "idle")).toBe(true);

    now = new Date(T0.getTime() + 2 * HOUR);
    await worker("worker-b").tick();
    expect(fetches.length).toBe(ORGS.length * 2);
    expect(probes.length).toBe(ORGS.length * 3);
  });
});
