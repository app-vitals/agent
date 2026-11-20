/**
 * admin/src/github-lookup-repositories.ts
 * The lookup-App repository lister exposed to extensions as
 * AdminPlatformServices.githubLookup. It reads the cached crawl snapshots
 * (GLC-1.2 crawler) and never calls GitHub, so a GitHub outage or rate limit
 * cannot fail it; the crawl state is reported in optional fields instead.
 *
 * A configured account with no snapshot yet returns an empty list with
 * syncState "syncing" (older consumers treat that as their existing empty-list
 * path). The stored-App wiring lives in github-enterprise-api.ts.
 */

export interface GithubLookupRepository {
  fullName: string;
  archived: boolean;
}

/** syncing: a crawl is incomplete; ready: complete and fresh; stale: complete but past the TTL; failed: the last crawl errored. */
export type GithubLookupSyncState = "syncing" | "ready" | "stale" | "failed";

export interface GithubLookupProgress {
  reposSeen: number;
  /** Sum of GitHub's total_count across orgs; absent until every org reports one. */
  totalCount?: number;
}

export interface GithubLookupRepositories {
  configured: boolean;
  repos: GithubLookupRepository[];
  /** Optional: consumers that predate the cache ignore these. */
  syncState?: GithubLookupSyncState;
  /** Oldest completed crawl across orgs; absent until one has completed. */
  fetchedAt?: Date;
  progress?: GithubLookupProgress;
}

/** The extension-facing lister (optional member of AdminPlatformServices). */
export interface GithubLookupService {
  /** Lists the account's App pair, else the deployment-wide pair (no argument: deployment-wide). */
  listRepositories(
    accountId?: string | null,
  ): Promise<GithubLookupRepositories>;
}

/** One org's cached snapshot with its repos. */
export interface LookupSnapshotView {
  completedAt: Date | null;
  totalCount: number | null;
  lastError: string | null;
  repos: GithubLookupRepository[];
}

/** Default age after which a completed crawl is reported stale (hourly refresh). */
export const DEFAULT_LOOKUP_TTL_MS = 3_600_000;

/** Folds per-org snapshots into one result: failed > syncing > stale > ready. */
export function summarizeLookupSnapshots(
  snapshots: LookupSnapshotView[],
  now: Date,
  ttlMs: number = DEFAULT_LOOKUP_TTL_MS,
): GithubLookupRepositories {
  if (snapshots.length === 0) {
    return { configured: true, repos: [], syncState: "syncing" };
  }
  const repos = new Map<string, GithubLookupRepository>();
  let reposSeen = 0;
  let totalCount: number | undefined = 0;
  let failed = false;
  let incomplete = false;
  let oldest: Date | undefined;
  for (const s of snapshots) {
    for (const r of s.repos) {
      repos.set(r.fullName, { fullName: r.fullName, archived: r.archived });
    }
    reposSeen += s.repos.length;
    totalCount =
      totalCount === undefined || s.totalCount === null
        ? undefined
        : totalCount + s.totalCount;
    if (s.completedAt) {
      if (!oldest || s.completedAt < oldest) oldest = s.completedAt;
    } else {
      incomplete = true;
      if (s.lastError) failed = true;
    }
  }
  const stale =
    oldest !== undefined && now.getTime() - oldest.getTime() > ttlMs;
  const syncState: GithubLookupSyncState = failed
    ? "failed"
    : incomplete
      ? "syncing"
      : stale
        ? "stale"
        : "ready";
  return {
    configured: true,
    repos: [...repos.values()],
    syncState,
    ...(oldest && !incomplete ? { fetchedAt: oldest } : {}),
    progress: {
      reposSeen,
      ...(totalCount === undefined ? {} : { totalCount }),
    },
  };
}
