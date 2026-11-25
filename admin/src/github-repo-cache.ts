/**
 * admin/src/github-repo-cache.ts
 * GitHubRepoCacheService — storage for the GitHub repo/access cache (GLC-1.1):
 * a per-org crawl snapshot, the repos each crawl saw, and per-user push access.
 *
 * Crawl generations: a crawl stamps every repo it sees with `seenAt >=
 * crawlStartedAt`; sweepGeneration() then deletes rows older than that, i.e.
 * repos that disappeared since the previous crawl.
 *
 * Leases are a compare-and-set on `leasedUntil` (one UPDATE), so of several
 * concurrent acquirers exactly one wins until the lease expires or is released.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError } from "./errors.ts";

export const GITHUB_REPO_APP_KINDS = ["lookup", "agent"] as const;
export type GitHubRepoAppKind = (typeof GITHUB_REPO_APP_KINDS)[number];

export const GITHUB_ACCESS_STATUSES = ["ok", "error", "terminal"] as const;
export type GitHubAccessStatus = (typeof GITHUB_ACCESS_STATUSES)[number];

export interface SnapshotKey {
  accountId: string;
  appKind: GitHubRepoAppKind;
  appRef: string;
  org: string;
}

export type SnapshotProgress = Partial<{
  crawlPage: number;
  crawlStartedAt: Date | null;
  completedAt: Date | null;
  totalCount: number | null;
  /** Agent snapshots: the App installation's repository selection; null = unknown. */
  repositorySelection: "all" | "selected" | null;
  lastError: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  rateLimitResetAt: Date | null;
  lastTickAt: Date | null;
}>;

export interface CachedRepoInput {
  githubId: number | bigint;
  fullName: string;
  archived?: boolean;
}

export interface AccessInput {
  accountId: string;
  org: string;
  repo: string;
  username: string;
  canPush: boolean;
  level?: string | null;
  status: GitHubAccessStatus;
  attempts?: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
}

export interface AccessQuery {
  accountId: string;
  org: string;
  username: string;
  /** Repo names (without org) to consider. */
  repos: string[];
  /** Rows with status ok older than this are expired. */
  maxAgeMs: number;
}

const REPO_BATCH_SIZE = 500;

/** A stored selection narrowed to the known values; anything else is unknown (null). */
function asSelection(raw: string | null): "all" | "selected" | null {
  return raw === "all" || raw === "selected" ? raw : null;
}

function requireNonEmpty(name: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${name} is required`);
  }
}

function validateKey(key: SnapshotKey): void {
  requireNonEmpty("accountId", key.accountId);
  requireNonEmpty("appRef", key.appRef);
  requireNonEmpty("org", key.org);
  if (!(GITHUB_REPO_APP_KINDS as readonly string[]).includes(key.appKind)) {
    throw new BadRequestError(
      `appKind must be one of: ${GITHUB_REPO_APP_KINDS.join(", ")}`,
    );
  }
}

function validatePositiveMs(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BadRequestError(`${name} must be a positive number`);
  }
}

export class GitHubRepoCacheService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = SystemClock(),
  ) {}

  private where(key: SnapshotKey) {
    return {
      accountId_appKind_appRef_org: {
        accountId: key.accountId,
        appKind: key.appKind,
        appRef: key.appRef,
        org: key.org,
      },
    };
  }

  /** Create the snapshot row, or merge `progress` into the existing one. */
  async upsertSnapshot(key: SnapshotKey, progress: SnapshotProgress = {}) {
    validateKey(key);
    return this.prisma.gitHubRepoSnapshot.upsert({
      where: this.where(key),
      create: { ...key, ...progress },
      update: progress,
    });
  }

  async getSnapshot(key: SnapshotKey) {
    validateKey(key);
    return this.prisma.gitHubRepoSnapshot.findUnique({
      where: this.where(key),
    });
  }

  /** Lookup-App snapshots (with their repos) for the account scopes and App id. Reads only the cache. */
  async listLookupSnapshots(accountIds: string[], appRef: string) {
    requireNonEmpty("appRef", appRef);
    const rows = await this.prisma.gitHubRepoSnapshot.findMany({
      where: { accountId: { in: accountIds }, appKind: "lookup", appRef },
      include: {
        repos: { select: { fullName: true, archived: true } },
      },
      orderBy: { org: "asc" },
    });
    return rows.map((r) => ({
      completedAt: r.completedAt,
      totalCount: r.totalCount,
      lastError: r.lastError,
      repos: r.repos,
    }));
  }

  /** Lookup-App snapshots with their org and repos (GitHub Sync, GLC-2.3). Reads only the cache. */
  async listLookupOrgSnapshots(accountIds: string[], appRef: string) {
    requireNonEmpty("appRef", appRef);
    const rows = await this.prisma.gitHubRepoSnapshot.findMany({
      where: { accountId: { in: accountIds }, appKind: "lookup", appRef },
      include: { repos: { select: { fullName: true, archived: true } } },
      orderBy: { org: "asc" },
    });
    return rows.map((r) => ({
      org: r.org,
      completedAt: r.completedAt,
      lastError: r.lastError,
      rateLimitResetAt: r.rateLimitResetAt,
      repos: r.repos,
    }));
  }

  /** Agent-App installation snapshots (with their repos) for one account scope and App id. Reads only the cache. */
  async listAgentSnapshots(accountId: string, appRef: string) {
    requireNonEmpty("accountId", accountId);
    requireNonEmpty("appRef", appRef);
    const rows = await this.prisma.gitHubRepoSnapshot.findMany({
      where: { accountId, appKind: "agent", appRef },
      include: { repos: { select: { fullName: true } } },
      orderBy: { org: "asc" },
    });
    return rows.map((r) => ({
      org: r.org,
      completedAt: r.completedAt,
      totalCount: r.totalCount,
      lastError: r.lastError,
      rateLimitResetAt: r.rateLimitResetAt,
      repositorySelection: asSelection(r.repositorySelection),
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      leaseHolder: r.leaseHolder,
      leasedUntil: r.leasedUntil,
      lastTickAt: r.lastTickAt,
      repos: r.repos,
    }));
  }

  /** Upsert repos for a snapshot in batches, stamping each with `seenAt`. */
  async upsertRepos(
    snapshotId: string,
    repos: CachedRepoInput[],
    seenAt: Date = this.clock.now(),
  ): Promise<number> {
    requireNonEmpty("snapshotId", snapshotId);
    for (const r of repos) {
      requireNonEmpty("fullName", r.fullName);
    }
    for (let i = 0; i < repos.length; i += REPO_BATCH_SIZE) {
      const batch = repos.slice(i, i + REPO_BATCH_SIZE);
      await this.prisma.$transaction(
        batch.map((r) =>
          this.prisma.gitHubCachedRepo.upsert({
            where: {
              snapshotId_githubId: {
                snapshotId,
                githubId: BigInt(r.githubId),
              },
            },
            create: {
              snapshotId,
              githubId: BigInt(r.githubId),
              fullName: r.fullName,
              archived: r.archived ?? false,
              seenAt,
            },
            update: {
              fullName: r.fullName,
              archived: r.archived ?? false,
              seenAt,
            },
          }),
        ),
      );
    }
    return repos.length;
  }

  /** Number of the snapshot's repos with `seenAt >= since` (distinct rows). */
  async countReposSeenSince(snapshotId: string, since: Date): Promise<number> {
    requireNonEmpty("snapshotId", snapshotId);
    return this.prisma.gitHubCachedRepo.count({
      where: { snapshotId, seenAt: { gte: since } },
    });
  }

  /**
   * Full names (owner/repo) of the repos cached for the snapshot, sorted.
   * Every repo by default; `excludeArchived` leaves out archived ones.
   */
  async listRepoFullNames(
    snapshotId: string,
    opts: { excludeArchived?: boolean } = {},
  ): Promise<string[]> {
    requireNonEmpty("snapshotId", snapshotId);
    const rows = await this.prisma.gitHubCachedRepo.findMany({
      where: {
        snapshotId,
        ...(opts.excludeArchived ? { archived: false } : {}),
      },
      select: { fullName: true },
      orderBy: { fullName: "asc" },
    });
    return rows.map((r) => r.fullName);
  }

  /**
   * Delete repos last seen before the snapshot's crawlStartedAt. Returns the
   * number deleted; 0 (and deletes nothing) when no crawl has started.
   */
  async sweepGeneration(snapshotId: string): Promise<number> {
    requireNonEmpty("snapshotId", snapshotId);
    const snap = await this.prisma.gitHubRepoSnapshot.findUnique({
      where: { id: snapshotId },
      select: { crawlStartedAt: true },
    });
    if (!snap?.crawlStartedAt) return 0;
    const { count } = await this.prisma.gitHubCachedRepo.deleteMany({
      where: { snapshotId, seenAt: { lt: snap.crawlStartedAt } },
    });
    return count;
  }

  /**
   * Refresh request (GLC-2.4): make every snapshot's work the next thing the
   * refresher runs, without touching GitHub. A completed list is aged to
   * `staleBefore` (callers pass a time past the staleness cap, so the planner
   * ranks it ahead of expired-only work); any snapshot's crawl backoff
   * (nextAttemptAt) is cleared, and so is the backoff on access pairs that
   * are still pending (status error). Leases and rateLimitResetAt are left
   * alone, so the lease and the rate-limit window still gate the work.
   * Terminal and ok access rows are not touched.
   */
  async markStale(staleBefore: Date): Promise<{
    snapshots: number;
    accessPairs: number;
  }> {
    const aged = await this.prisma.gitHubRepoSnapshot.updateMany({
      where: { completedAt: { gt: staleBefore } },
      data: { completedAt: staleBefore },
    });
    const backoff = await this.prisma.gitHubRepoSnapshot.updateMany({
      where: { nextAttemptAt: { not: null } },
      data: { nextAttemptAt: null },
    });
    const access = await this.prisma.gitHubRepoAccess.updateMany({
      where: { status: "error", nextAttemptAt: { not: null } },
      data: { nextAttemptAt: null },
    });
    return {
      snapshots: Math.max(aged.count, backoff.count),
      accessPairs: access.count,
    };
  }

  /**
   * Take the org's lease for `ttlMs`. True when this holder now owns it; false
   * when another holder's lease is still live or the snapshot does not exist.
   */
  async acquireLease(
    snapshotId: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    requireNonEmpty("snapshotId", snapshotId);
    requireNonEmpty("holder", holder);
    validatePositiveMs("ttlMs", ttlMs);
    const now = this.clock.now();
    const { count } = await this.prisma.gitHubRepoSnapshot.updateMany({
      where: {
        id: snapshotId,
        OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }],
      },
      data: {
        leaseHolder: holder,
        leasedUntil: new Date(now.getTime() + ttlMs),
      },
    });
    return count === 1;
  }

  /** Release the lease if `holder` still owns it. Idempotent. */
  async releaseLease(snapshotId: string, holder: string): Promise<void> {
    requireNonEmpty("snapshotId", snapshotId);
    requireNonEmpty("holder", holder);
    await this.prisma.gitHubRepoSnapshot.updateMany({
      where: { id: snapshotId, leaseHolder: holder },
      data: { leaseHolder: null, leasedUntil: null },
    });
  }

  async upsertAccess(input: AccessInput) {
    requireNonEmpty("accountId", input.accountId);
    requireNonEmpty("org", input.org);
    requireNonEmpty("repo", input.repo);
    requireNonEmpty("username", input.username);
    if (!(GITHUB_ACCESS_STATUSES as readonly string[]).includes(input.status)) {
      throw new BadRequestError(
        `status must be one of: ${GITHUB_ACCESS_STATUSES.join(", ")}`,
      );
    }
    const data = {
      canPush: input.canPush,
      level: input.level ?? null,
      checkedAt: this.clock.now(),
      status: input.status,
      attempts: input.attempts ?? 0,
      nextAttemptAt: input.nextAttemptAt ?? null,
      lastError: input.lastError ?? null,
    };
    return this.prisma.gitHubRepoAccess.upsert({
      where: {
        accountId_org_repo_username: {
          accountId: input.accountId,
          org: input.org,
          repo: input.repo,
          username: input.username,
        },
      },
      create: {
        accountId: input.accountId,
        org: input.org,
        repo: input.repo,
        username: input.username,
        ...data,
      },
      update: data,
    });
  }

  /**
   * Repos in `query.repos` that still need an access check: no row yet, an ok
   * row older than maxAgeMs, or an error row whose nextAttemptAt has passed.
   * Terminal rows are never returned.
   */
  async findMissingOrExpiredAccess(query: AccessQuery): Promise<string[]> {
    requireNonEmpty("accountId", query.accountId);
    requireNonEmpty("org", query.org);
    requireNonEmpty("username", query.username);
    validatePositiveMs("maxAgeMs", query.maxAgeMs);
    if (query.repos.length === 0) return [];
    const now = this.clock.now();
    const rows = await this.prisma.gitHubRepoAccess.findMany({
      where: {
        accountId: query.accountId,
        org: query.org,
        username: query.username,
        repo: { in: query.repos },
      },
    });
    const staleBefore = now.getTime() - query.maxAgeMs;
    const settled = new Set<string>();
    for (const row of rows) {
      const due =
        row.status === "ok"
          ? row.checkedAt.getTime() < staleBefore
          : row.status === "error"
            ? row.nextAttemptAt === null || row.nextAttemptAt <= now
            : false;
      if (!due) settled.add(row.repo);
    }
    return query.repos.filter((r) => !settled.has(r));
  }

  /** Existing access rows for the user over `repos` (any status). */
  async getAccessRows(query: {
    accountId: string;
    org: string;
    username: string;
    repos: string[];
  }) {
    requireNonEmpty("accountId", query.accountId);
    requireNonEmpty("org", query.org);
    requireNonEmpty("username", query.username);
    if (query.repos.length === 0) return [];
    return this.prisma.gitHubRepoAccess.findMany({
      where: {
        accountId: query.accountId,
        org: query.org,
        username: query.username,
        repo: { in: query.repos },
      },
    });
  }
}
