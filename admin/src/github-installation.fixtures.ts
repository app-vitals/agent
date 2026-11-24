/**
 * admin/src/github-installation.fixtures.ts
 * Shared fakes for the installation repos / GitHub Sync wiring tests.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";

export const accessFor = (pushable: string[]): GithubAccessPreviewFn => {
  return async () => ({
    status: "ok",
    access: {
      username: "dev",
      outcome: "ok",
      userVerified: true,
      complete: true,
      unresolved: 0,
      checkedAt: "2026-11-11T00:00:00.000Z",
      orgs: [
        {
          org: "acme",
          status: "ok",
          unresolved: 0,
          repos: pushable.map((fullName) => ({
            fullName,
            level: "write" as const,
            canPush: true,
          })),
        },
      ],
    },
  });
};

/** Cached rows the fake prisma serves (GLC-2.3 sync reads them). */
export interface FakeCache {
  snapshots?: unknown[];
  access?: unknown[];
}

/** A completed agent-App snapshot plus ok access rows for `repos` in `org`, all checked at `checkedAt`. */
export function freshCache(
  org: string,
  repos: string[],
  pushable: string[],
  checkedAt: Date,
): FakeCache {
  return {
    snapshots: [
      {
        org,
        completedAt: checkedAt,
        totalCount: repos.length,
        lastError: null,
        rateLimitResetAt: null,
        attempts: 0,
        nextAttemptAt: null,
        leaseHolder: null,
        leasedUntil: null,
        lastTickAt: null,
        repos: repos.map((fullName) => ({ fullName })),
      },
    ],
    access: repos.map((f) => ({
      repo: f.slice(f.indexOf("/") + 1),
      status: "ok",
      canPush: pushable.includes(f),
      level: pushable.includes(f) ? "write" : "none",
      checkedAt,
      attempts: 0,
      lastError: null,
    })),
  };
}

export function fakePrisma(repos: string[], cache: FakeCache = {}) {
  const state = {
    repos: [...repos],
    audits: 0,
    snapshotQueries: [] as unknown[],
  };
  const prisma = {
    agent: {
      findUnique: async () => ({
        id: "a1",
        repos: state.repos,
        githubUsername: "dev",
      }),
      update: async (args: { data: { repos: string[] } }) => {
        state.repos = args.data.repos;
      },
    },
    gitHubRepoSnapshot: {
      findMany: async (args: unknown) => {
        state.snapshotQueries.push(args);
        return cache.snapshots ?? [];
      },
    },
    gitHubRepoAccess: { findMany: async () => cache.access ?? [] },
    gitHubReconcileAudit: {
      create: async () => {
        state.audits += 1;
        return { id: "audit-1" };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, state };
}

export function fakeOpenWork() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const port: OpenWorkPort = {
    listOpenWork: async (...args) => {
      calls.push({ fn: "list", args });
      return [{ id: "T-1", repo: "acme/old", title: "fix it" }];
    },
    blockOpenWork: async (...args) => {
      calls.push({ fn: "block", args });
    },
  };
  return { port, calls };
}

export const envWith = (env?: Record<string, string>) => ({
  getConfigBundle: async (agentId: string) =>
    env ? { env, agentId, allowedTools: [] } : null,
});

/** A lookup-App snapshot row as the crawler files it, keyed by its SnapshotKey accountId. */
export interface FakeLookupSnapshot {
  accountId: string;
  appRef: string;
  org: string;
  completedAt: Date;
  repos: { fullName: string }[];
}

/**
 * Serves `appKind: "lookup"` reads from `rows` honouring the `accountId.in`
 * and `appRef` filters, so a wrong account key returns nothing. Other reads
 * fall through to the fake's own snapshot rows.
 */
export function withLookupSnapshots(
  prisma: PrismaClient,
  rows: FakeLookupSnapshot[],
) {
  const snapshots = prisma.gitHubRepoSnapshot as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  const base = snapshots.findMany;
  snapshots.findMany = async (args: unknown) => {
    const where = (
      args as {
        where: {
          accountId?: { in: string[] };
          appKind?: string;
          appRef?: string;
        };
      }
    ).where;
    if (where.appKind !== "lookup") return base(args);
    await base(args);
    return rows.filter(
      (r) =>
        where.accountId?.in.includes(r.accountId) && r.appRef === where.appRef,
    );
  };
  return prisma;
}
