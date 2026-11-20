/**
 * admin/src/github-repo-crawler.ts
 * Resumable, rate-limit-aware crawl of an org's GitHub repositories into the
 * repo cache (GLC-1.2). The engine is generic over a PageSource port; the
 * lookup-App source (lookupRepoPageSource) adapts GithubLookupClient.
 *
 * One call to crawlRepos() is one run:
 * - Fresh start (no crawl in progress, or the last one completed or was
 *   abandoned): crawlStartedAt = now, completedAt = null, from page 1.
 * - Resume: keep crawlStartedAt, start at max(1, crawlPage - 1). The overlap
 *   page catches rows that shifted back a page between runs; GitHub's order
 *   is not documented, so nothing here relies on it.
 * - Each page is upserted (seenAt = now) and crawlPage saved as it lands.
 * - On the last page, the distinct rows seen this crawl (seenAt >=
 *   crawlStartedAt) are compared with total_count. Equal: completedAt is set
 *   and the generation sweep drops rows from earlier crawls. Unequal: the
 *   crawl is not trusted, completedAt stays unset, and the next run starts
 *   over from page 1. A partial crawl never sweeps.
 * - A rate limit records rateLimitResetAt and ends the run cleanly (no
 *   attempts/lastError); runs before that time do not fetch. Other source
 *   errors record lastError, bump attempts and set a backoff nextAttemptAt.
 */

import type { Clock } from "./clock.ts";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  type GithubLookupClient,
  GithubLookupRateLimitError,
  rateLimitResetAt,
} from "./github-lookup-client.ts";
import type {
  CachedRepoInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";

/** One page of the listing being crawled. */
export interface RepoPage {
  repos: CachedRepoInput[];
  /** The source's total row count for the whole listing. */
  totalCount: number;
  /** Whether a further page exists. An empty page is always the last. */
  hasNext: boolean;
  /** Quota state reported with this page; remaining 0 ends the run. */
  rateLimit?: { remaining: number | null; resetAt: Date | null };
}

/**
 * Port: fetch page `page` (1-based). A rate limit is signalled by throwing a
 * GithubEnterpriseError of kind "rate_limit" (GithubLookupRateLimitError
 * carries the exact resetAt). Implementations must time out their fetches.
 */
export interface PageSource {
  fetchPage(page: number): Promise<RepoPage>;
}

/** The snapshot fields the engine reads. */
export interface CrawlSnapshot {
  id: string;
  crawlPage: number;
  crawlStartedAt: Date | null;
  completedAt: Date | null;
  totalCount: number | null;
  lastError: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  rateLimitResetAt: Date | null;
  lastTickAt: Date | null;
}

/** Port: the storage the engine needs. GitHubRepoCacheService satisfies it. */
export interface CrawlStore {
  getSnapshot(key: SnapshotKey): Promise<CrawlSnapshot | null>;
  upsertSnapshot(
    key: SnapshotKey,
    progress?: SnapshotProgress,
  ): Promise<CrawlSnapshot>;
  upsertRepos(
    snapshotId: string,
    repos: CachedRepoInput[],
    seenAt?: Date,
  ): Promise<number>;
  countReposSeenSince(snapshotId: string, since: Date): Promise<number>;
  sweepGeneration(snapshotId: string): Promise<number>;
}

export type CrawlOutcome =
  /** Last page reached and seen rows matched total_count; swept. */
  | "complete"
  /** Last page reached but the counts disagreed; next run restarts. */
  | "incomplete"
  /** Page budget used up; next run resumes. */
  | "in_progress"
  /** Stopped on a rate limit; next run resumes after rateLimitResetAt. */
  | "rate_limited"
  /** A source error; recorded on the snapshot. */
  | "failed";

export interface CrawlResult {
  outcome: CrawlOutcome;
  pagesFetched: number;
  /** Rows deleted by the generation sweep (complete only). */
  swept?: number;
  rateLimitResetAt?: Date;
  error?: string;
}

export interface CrawlOptions {
  key: SnapshotKey;
  source: PageSource;
  store: CrawlStore;
  clock: Clock;
  /** Most pages to fetch in this run. Default 1000. */
  maxPages?: number;
  /** Delay before retrying after the n-th consecutive failure. */
  backoffMs?: (attempts: number) => number;
}

const DEFAULT_MAX_PAGES = 1000;
const MAX_ERROR_LENGTH = 500;

/** 1m, 2m, 4m, ... capped at 1h. */
export function defaultCrawlBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

export async function crawlRepos(opts: CrawlOptions): Promise<CrawlResult> {
  const { key, source, store, clock } = opts;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const backoffMs = opts.backoffMs ?? defaultCrawlBackoffMs;

  let snap =
    (await store.getSnapshot(key)) ?? (await store.upsertSnapshot(key));

  const resetAt = snap.rateLimitResetAt;
  if (resetAt && resetAt.getTime() > clock.now().getTime()) {
    return {
      outcome: "rate_limited",
      pagesFetched: 0,
      rateLimitResetAt: resetAt,
    };
  }

  const fresh =
    snap.crawlStartedAt === null ||
    snap.completedAt !== null ||
    snap.crawlPage < 1;
  if (fresh) {
    snap = await store.upsertSnapshot(key, {
      crawlStartedAt: clock.now(),
      completedAt: null,
      crawlPage: 0,
      totalCount: null,
    });
  }
  const crawlStartedAt = snap.crawlStartedAt as Date;
  const startPage = fresh ? 1 : Math.max(1, snap.crawlPage - 1);

  let pagesFetched = 0;
  for (let page = startPage; pagesFetched < maxPages; page++) {
    let result: RepoPage;
    try {
      result = await source.fetchPage(page);
    } catch (err) {
      return recordError(err);
    }
    pagesFetched++;

    await store.upsertRepos(snap.id, result.repos, clock.now());
    await store.upsertSnapshot(key, {
      crawlPage: page,
      totalCount: result.totalCount,
      rateLimitResetAt: null,
      lastTickAt: clock.now(),
    });

    const last = !result.hasNext || result.repos.length === 0;
    if (last) return finish(result.totalCount);

    const rl = result.rateLimit;
    if (rl && rl.remaining === 0) {
      const at = rateLimitResetAt(
        { remaining: 0, resetAt: rl.resetAt, retryAfterSeconds: null },
        clock.now(),
      );
      await store.upsertSnapshot(key, { rateLimitResetAt: at });
      return { outcome: "rate_limited", pagesFetched, rateLimitResetAt: at };
    }
  }
  return { outcome: "in_progress", pagesFetched };

  async function finish(totalCount: number): Promise<CrawlResult> {
    const seen = await store.countReposSeenSince(snap.id, crawlStartedAt);
    if (seen !== totalCount) {
      const error = `total_count mismatch: saw ${seen} repos this crawl, GitHub reported ${totalCount}`;
      await store.upsertSnapshot(key, {
        crawlPage: 0,
        completedAt: null,
        lastError: error,
        lastTickAt: clock.now(),
      });
      return { outcome: "incomplete", pagesFetched, error };
    }
    await store.upsertSnapshot(key, {
      completedAt: clock.now(),
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
      lastTickAt: clock.now(),
    });
    const swept = await store.sweepGeneration(snap.id);
    return { outcome: "complete", pagesFetched, swept };
  }

  async function recordError(err: unknown): Promise<CrawlResult> {
    const now = clock.now();
    if (err instanceof GithubEnterpriseError && err.kind === "rate_limit") {
      const at =
        err instanceof GithubLookupRateLimitError
          ? err.resetAt
          : rateLimitResetAt(
              {
                remaining: null,
                resetAt: null,
                retryAfterSeconds: err.retryAfterSeconds ?? null,
              },
              now,
            );
      await store.upsertSnapshot(key, {
        rateLimitResetAt: at,
        lastTickAt: now,
      });
      return { outcome: "rate_limited", pagesFetched, rateLimitResetAt: at };
    }
    const error = (err instanceof Error ? err.message : String(err)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    const attempts = snap.attempts + 1;
    await store.upsertSnapshot(key, {
      lastError: error,
      attempts,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      lastTickAt: now,
    });
    return { outcome: "failed", pagesFetched, error };
  }
}

/** PageSource over the lookup App's GET /installation/repositories for `org`. */
export function lookupRepoPageSource(
  client: Pick<GithubLookupClient, "listInstallationRepositoriesPage">,
  org: string,
): PageSource {
  return {
    async fetchPage(page: number): Promise<RepoPage> {
      const res = await client.listInstallationRepositoriesPage(org, page);
      return {
        repos: res.repositories.map((r) => ({
          githubId: r.id,
          fullName: r.fullName,
          archived: r.archived,
        })),
        totalCount: res.totalCount,
        hasNext: res.hasNext,
        rateLimit: {
          remaining: res.rateLimit.remaining,
          resetAt: res.rateLimit.resetAt,
        },
      };
    },
  };
}
