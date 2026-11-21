/**
 * Integration tests for GitHubRepoCacheService against a real PostgreSQL DB.
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const key = {
  accountId: "acc",
  appKind: "lookup" as const,
  appRef: "1",
  org: "acme",
};
const T0 = new Date("2026-11-20T12:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describeOrSkip("GitHubRepoCacheService (integration)", () => {
  let prisma: PrismaClient;
  let now: Date;
  let svc: GitHubRepoCacheService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    await prisma.gitHubRepoAccess.deleteMany();
    now = T0;
    svc = new GitHubRepoCacheService(prisma, { now: () => now });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("upserts and reads a snapshot, merging progress", async () => {
    expect(await svc.getSnapshot(key)).toBeNull();
    const a = await svc.upsertSnapshot(key, { crawlPage: 1, totalCount: 5 });
    const b = await svc.upsertSnapshot(key, { crawlPage: 2 });
    expect(b.id).toBe(a.id);
    expect(b.crawlPage).toBe(2);
    expect(b.totalCount).toBe(5);
    expect((await svc.getSnapshot(key))?.id).toBe(a.id);
  });

  it("batch-upserts repos without duplicating", async () => {
    const snap = await svc.upsertSnapshot(key);
    const repos = Array.from({ length: 1200 }, (_, i) => ({
      githubId: 10_000_000_000 + i,
      fullName: `acme/r${i}`,
    }));
    await svc.upsertRepos(snap.id, repos, T0);
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 10_000_000_000, fullName: "acme/renamed", archived: true }],
      min(1),
    );
    expect(await prisma.gitHubCachedRepo.count()).toBe(1200);
    const r = await prisma.gitHubCachedRepo.findFirstOrThrow({
      where: { githubId: 10_000_000_000n },
    });
    expect(r.fullName).toBe("acme/renamed");
    expect(r.archived).toBe(true);
  });

  it("lists a snapshot's repo full names, sorted, and no other snapshot's", async () => {
    const snap = await svc.upsertSnapshot(key);
    const other = await svc.upsertSnapshot({ ...key, org: "other" });
    await svc.upsertRepos(snap.id, [
      { githubId: 2, fullName: "acme/web" },
      { githubId: 1, fullName: "acme/api" },
    ]);
    await svc.upsertRepos(other.id, [{ githubId: 3, fullName: "other/x" }]);
    expect(await svc.listRepoFullNames(snap.id)).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });

  it("sweep deletes only rows seen before crawlStartedAt", async () => {
    const snap = await svc.upsertSnapshot(key, { crawlStartedAt: min(10) });
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 1, fullName: "acme/old" }],
      min(5),
    );
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 2, fullName: "acme/new" }],
      min(10),
    );
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 3, fullName: "acme/newer" }],
      min(11),
    );
    expect(await svc.sweepGeneration(snap.id)).toBe(1);
    const left = await prisma.gitHubCachedRepo.findMany({
      orderBy: { githubId: "asc" },
    });
    expect(left.map((r) => r.fullName)).toEqual(["acme/new", "acme/newer"]);
  });

  it("sweep is a no-op before a crawl has started and spares other snapshots", async () => {
    const a = await svc.upsertSnapshot(key);
    const b = await svc.upsertSnapshot(
      { ...key, org: "other" },
      { crawlStartedAt: min(10) },
    );
    await svc.upsertRepos(a.id, [{ githubId: 1, fullName: "acme/x" }], min(1));
    await svc.upsertRepos(
      b.id,
      [{ githubId: 2, fullName: "other/y" }],
      min(20),
    );
    expect(await svc.sweepGeneration(a.id)).toBe(0);
    expect(await prisma.gitHubCachedRepo.count()).toBe(2);
  });

  it("lease: first concurrent acquirer wins; others fail until expiry", async () => {
    const snap = await svc.upsertSnapshot(key);
    const results = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((w) => svc.acquireLease(snap.id, w, 60_000)),
    );
    expect(results.filter(Boolean).length).toBe(1);
    const holder = (await svc.getSnapshot(key))?.leaseHolder as string;
    expect(await svc.acquireLease(snap.id, "late", 60_000)).toBe(false);
    now = min(2); // past leasedUntil
    expect(await svc.acquireLease(snap.id, "late", 60_000)).toBe(true);
    expect((await svc.getSnapshot(key))?.leaseHolder).toBe("late");
    expect(holder).not.toBe("late");
  });

  it("lease: release is idempotent, owner-only, and frees the lease", async () => {
    const snap = await svc.upsertSnapshot(key);
    expect(await svc.acquireLease(snap.id, "w1", 60_000)).toBe(true);
    await svc.releaseLease(snap.id, "intruder");
    expect((await svc.getSnapshot(key))?.leaseHolder).toBe("w1");
    await svc.releaseLease(snap.id, "w1");
    await svc.releaseLease(snap.id, "w1");
    expect((await svc.getSnapshot(key))?.leaseHolder).toBeNull();
    expect(await svc.acquireLease(snap.id, "w2", 60_000)).toBe(true);
  });

  it("acquire on a missing snapshot returns false", async () => {
    expect(await svc.acquireLease("nope", "w", 1000)).toBe(false);
  });

  it("access: missing-or-expired query", async () => {
    const base = {
      accountId: "acc",
      org: "acme",
      username: "dan",
      canPush: true,
    };
    await svc.upsertAccess({ ...base, repo: "fresh", status: "ok" });
    await svc.upsertAccess({
      ...base,
      repo: "terminal",
      status: "terminal",
      lastError: "404",
    });
    await svc.upsertAccess({
      ...base,
      repo: "err-later",
      status: "error",
      attempts: 1,
      nextAttemptAt: min(30),
    });
    await svc.upsertAccess({
      ...base,
      repo: "err-due",
      status: "error",
      attempts: 1,
      nextAttemptAt: min(-1),
    });
    await svc.upsertAccess({
      ...base,
      repo: "other-user",
      status: "ok",
      username: "eve",
    });
    const repos = [
      "fresh",
      "terminal",
      "err-later",
      "err-due",
      "other-user",
      "absent",
    ];
    const q = {
      accountId: "acc",
      org: "acme",
      username: "dan",
      repos,
      maxAgeMs: 3_600_000,
    };
    expect(await svc.findMissingOrExpiredAccess(q)).toEqual([
      "err-due",
      "other-user",
      "absent",
    ]);
    now = min(120); // everything ok is now older than 1h; error-later is due too
    expect(await svc.findMissingOrExpiredAccess(q)).toEqual([
      "fresh",
      "err-later",
      "err-due",
      "other-user",
      "absent",
    ]);
  });

  it("access: upsert updates in place", async () => {
    const base = { accountId: "acc", org: "acme", username: "dan", repo: "r" };
    await svc.upsertAccess({
      ...base,
      canPush: false,
      status: "error",
      attempts: 1,
    });
    await svc.upsertAccess({
      ...base,
      canPush: true,
      level: "write",
      status: "ok",
    });
    const rows = await prisma.gitHubRepoAccess.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      canPush: true,
      level: "write",
      status: "ok",
      attempts: 0,
    });
  });
});
