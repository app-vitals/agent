/**
 * admin/src/github-refresh-action.unit.test.ts
 * GLC-2.4: stale-marking resets the right rows (and only those), and the
 * action never touches leases or rate-limit windows. Fake prisma; no DB.
 */

import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createGithubRefreshAction } from "./github-refresh-action.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";

type Call = { model: string; args: { where: unknown; data: unknown } };

function fakePrisma(counts = { snap: 2, access: 3 }) {
  const calls: Call[] = [];
  const model = (name: string, count: number) => ({
    updateMany: async (args: Call["args"]) => {
      calls.push({ model: name, args });
      return { count };
    },
  });
  const prisma = {
    gitHubRepoSnapshot: model("snapshot", counts.snap),
    gitHubRepoAccess: model("access", counts.access),
  } as unknown as PrismaClient;
  return { prisma, calls };
}

describe("GitHubRepoCacheService.markStale", () => {
  const staleBefore = new Date("2026-11-01T00:00:00Z");

  it("ages completed snapshots, clears backoff on snapshots and pending access pairs", async () => {
    const { prisma, calls } = fakePrisma();
    const res = await new GitHubRepoCacheService(prisma).markStale(staleBefore);
    expect(res).toEqual({ snapshots: 2, accessPairs: 3 });
    expect(calls).toEqual([
      {
        model: "snapshot",
        args: {
          where: { completedAt: { gt: staleBefore } },
          data: { completedAt: staleBefore },
        },
      },
      {
        model: "snapshot",
        args: {
          where: { nextAttemptAt: { not: null } },
          data: { nextAttemptAt: null },
        },
      },
      {
        model: "access",
        args: {
          where: { status: "error", nextAttemptAt: { not: null } },
          data: { nextAttemptAt: null },
        },
      },
    ]);
  });

  it("never writes the lease, rate-limit or terminal/ok-row columns", async () => {
    const { prisma, calls } = fakePrisma();
    await new GitHubRepoCacheService(prisma).markStale(staleBefore);
    for (const c of calls) {
      const written = Object.keys(c.args.data as object);
      for (const col of [
        "leaseHolder",
        "leasedUntil",
        "rateLimitResetAt",
        "status",
        "checkedAt",
      ]) {
        expect(written).not.toContain(col);
      }
    }
    const access = calls.find((c) => c.model === "access");
    expect(JSON.stringify(access?.args.where)).toContain('"status":"error"');
  });
});

describe("createGithubRefreshAction", () => {
  const now = new Date("2026-11-20T12:00:00Z");

  it("marks snapshots past the staleness cap and notifies", async () => {
    const seen: Date[] = [];
    let notified = 0;
    const action = createGithubRefreshAction({
      cache: {
        markStale: async (d: Date) => {
          seen.push(d);
          return { snapshots: 1, accessPairs: 0 };
        },
      },
      stalenessCapMs: 6 * 3_600_000,
      onMarked: () => {
        notified++;
      },
      clock: { now: () => now },
    });
    expect(await action.requestRefresh()).toEqual({
      snapshots: 1,
      accessPairs: 0,
    });
    expect(seen[0]?.getTime()).toBeLessThan(now.getTime() - 6 * 3_600_000);
    expect(notified).toBe(1);
  });

  it("ignores a failing onMarked hook", async () => {
    const action = createGithubRefreshAction({
      cache: { markStale: async () => ({ snapshots: 0, accessPairs: 0 }) },
      stalenessCapMs: 1000,
      onMarked: () => {
        throw new Error("boom");
      },
    });
    await expect(action.requestRefresh()).resolves.toEqual({
      snapshots: 0,
      accessPairs: 0,
    });
  });
});
