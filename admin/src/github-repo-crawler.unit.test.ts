/**
 * admin/src/github-repo-crawler.unit.test.ts
 * Unit tests for the resumable repo crawl engine, driven by a fake PageSource
 * and an in-memory CrawlStore that mirrors GitHubRepoCacheService semantics.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import { GithubLookupRateLimitError } from "./github-lookup-client.ts";
import type {
  CachedRepoInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";
import {
  type CrawlSnapshot,
  type CrawlStore,
  crawlRepos,
  type PageSource,
  type RepoPage,
} from "./github-repo-crawler.ts";

const KEY: SnapshotKey = {
  accountId: "acc",
  appKind: "lookup",
  appRef: "555",
  org: "acme",
};
const T0 = new Date("2026-11-20T12:00:00Z");

class ManualClock {
  t = T0.getTime();
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Row {
  fullName: string;
  seenAt: Date;
}

class MemoryStore implements CrawlStore {
  snap: CrawlSnapshot | null = null;
  rows = new Map<number, Row>();
  sweeps = 0;
  upsertCalls = 0;

  async getSnapshot(_key: SnapshotKey) {
    return this.snap ? { ...this.snap } : null;
  }

  async upsertSnapshot(_key: SnapshotKey, progress: SnapshotProgress = {}) {
    const base: CrawlSnapshot = this.snap ?? {
      id: "snap1",
      crawlPage: 0,
      crawlStartedAt: null,
      completedAt: null,
      totalCount: null,
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
      rateLimitResetAt: null,
      lastTickAt: null,
    };
    const next = { ...base } as Record<string, unknown>;
    for (const [k, v] of Object.entries(progress)) {
      if (v !== undefined) next[k] = v;
    }
    this.snap = next as unknown as CrawlSnapshot;
    return { ...this.snap };
  }

  async upsertRepos(_id: string, repos: CachedRepoInput[], seenAt: Date) {
    this.upsertCalls++;
    for (const r of repos) {
      this.rows.set(Number(r.githubId), { fullName: r.fullName, seenAt });
    }
    return repos.length;
  }

  async countReposSeenSince(_id: string, since: Date) {
    let n = 0;
    for (const r of this.rows.values()) if (r.seenAt >= since) n++;
    return n;
  }

  async sweepGeneration(_id: string) {
    this.sweeps++;
    const since = this.snap?.crawlStartedAt;
    if (!since) return 0;
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.seenAt < since) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

const repo = (id: number): CachedRepoInput => ({
  githubId: id,
  fullName: `acme/r${id}`,
});

/**
 * A fake GitHub listing: `ids` is the current server-side order, sliced into
 * pages of `perPage`. `onFetch` may throw, return a canned response, or
 * mutate the listing (to simulate repos appearing mid-crawl).
 */
class FakeSource implements PageSource {
  fetched: number[] = [];
  totalOverride: number | null = null;
  onFetch: ((page: number) => RepoPage | undefined) | null = null;

  constructor(
    public ids: number[],
    private readonly perPage = 2,
  ) {}

  async fetchPage(page: number): Promise<RepoPage> {
    this.fetched.push(page);
    const canned = this.onFetch?.(page);
    if (canned) return canned;
    const start = (page - 1) * this.perPage;
    const slice = this.ids.slice(start, start + this.perPage);
    return {
      repos: slice.map(repo),
      totalCount: this.totalOverride ?? this.ids.length,
      hasNext: start + this.perPage < this.ids.length,
    };
  }
}

let clock: ManualClock;
let store: MemoryStore;

beforeEach(() => {
  clock = new ManualClock();
  store = new MemoryStore();
});

const run = (source: PageSource) =>
  crawlRepos({ key: KEY, source, store, clock });

describe("crawlRepos: fresh crawl", () => {
  it("persists every page, completes, and sweeps the previous generation", async () => {
    store.rows.set(99, { fullName: "acme/gone", seenAt: new Date(0) });
    const source = new FakeSource([1, 2, 3, 4, 5]);
    clock.advance(1);
    const out = await run(source);
    expect(out.outcome).toBe("complete");
    expect(source.fetched).toEqual([1, 2, 3]);
    expect(store.upsertCalls).toBe(3);
    expect(store.sweeps).toBe(1);
    expect([...store.rows.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(store.snap?.completedAt).toEqual(clock.now());
    expect(store.snap?.crawlStartedAt).toEqual(new Date(T0.getTime() + 1));
    expect(store.snap?.crawlPage).toBe(3);
    expect(store.snap?.totalCount).toBe(5);
    expect(out.swept).toBe(1);
  });

  it("starts a new generation after a completed crawl", async () => {
    const source = new FakeSource([1, 2, 3]);
    await run(source);
    const firstStart = store.snap?.crawlStartedAt;
    clock.advance(60_000);
    source.fetched = [];
    const out = await run(source);
    expect(out.outcome).toBe("complete");
    expect(source.fetched).toEqual([1, 2]);
    expect(store.snap?.crawlStartedAt).not.toEqual(firstStart);
    expect(store.snap?.crawlStartedAt).toEqual(clock.now());
  });

  it("clears completedAt when a new crawl starts", async () => {
    const source = new FakeSource([1, 2, 3]);
    await run(source);
    clock.advance(1000);
    source.onFetch = (p) => {
      if (p === 2) throw new GithubEnterpriseError("server", "boom");
      return undefined;
    };
    const out = await run(source);
    expect(out.outcome).toBe("failed");
    expect(store.snap?.completedAt).toBeNull();
  });
});

describe("crawlRepos: resume", () => {
  it("restarts from the saved page minus one and completes without duplicating rows", async () => {
    const source = new FakeSource([1, 2, 3, 4, 5, 6, 7, 8]);
    source.onFetch = (p) => {
      if (p === 4) throw new GithubEnterpriseError("server", "HTTP 502");
      return undefined;
    };
    const first = await run(source);
    expect(first.outcome).toBe("failed");
    expect(source.fetched).toEqual([1, 2, 3, 4]);
    expect(store.snap?.crawlPage).toBe(3);
    expect(store.snap?.lastError).toContain("HTTP 502");
    expect(store.snap?.attempts).toBe(1);
    expect(store.snap?.nextAttemptAt).not.toBeNull();
    expect(store.snap?.completedAt).toBeNull();
    expect(store.sweeps).toBe(0);
    const startedAt = store.snap?.crawlStartedAt;

    clock.advance(5 * 60_000);
    source.onFetch = null;
    source.fetched = [];
    const second = await run(source);
    expect(second.outcome).toBe("complete");
    expect(source.fetched).toEqual([2, 3, 4]);
    expect(store.rows.size).toBe(8);
    expect(store.snap?.crawlStartedAt).toEqual(startedAt);
    expect(store.snap?.completedAt).not.toBeNull();
    expect(store.snap?.lastError).toBeNull();
    expect(store.snap?.attempts).toBe(0);
    expect(store.snap?.nextAttemptAt).toBeNull();
  });

  it("resumes from page 1 when only page 1 was saved", async () => {
    const source = new FakeSource([1, 2, 3, 4]);
    source.onFetch = (p) => {
      if (p === 2) throw new GithubEnterpriseError("network", "timeout");
      return undefined;
    };
    await run(source);
    expect(store.snap?.crawlPage).toBe(1);
    source.onFetch = null;
    source.fetched = [];
    expect((await run(source)).outcome).toBe("complete");
    expect(source.fetched).toEqual([1, 2]);
  });

  it("the overlapping page catches a row that shifted back across the page boundary", async () => {
    // Listing [1..8], pages of 2. The crawl saves pages 1-3 then fails on 4.
    const source = new FakeSource([1, 2, 3, 4, 5, 6, 7, 8]);
    source.onFetch = (p) => {
      if (p === 4) throw new GithubEnterpriseError("server", "HTTP 500");
      return undefined;
    };
    await run(source);
    expect(store.snap?.crawlPage).toBe(3);
    // Repo 2 is deleted: everything shifts one slot left; repo 7 moves from
    // page 4 back to page 3. Resuming at page 4 alone would miss it.
    source.ids = [1, 3, 4, 5, 6, 7, 8];
    source.onFetch = null;
    source.fetched = [];
    const out = await run(source);
    expect(source.fetched).toEqual([2, 3, 4]);
    expect(store.rows.has(7)).toBe(true);
    // Repo 2 was seen this crawl before it was deleted: seen (8) != total (7),
    // so the crawl is not trusted and restarts from page 1 next time.
    expect(out.outcome).toBe("incomplete");
    expect(store.snap?.crawlPage).toBe(0);
  });
});

describe("crawlRepos: total_count", () => {
  it("leaves completedAt unset on a mismatch and restarts from page 1 next run", async () => {
    const source = new FakeSource([1, 2, 3, 4, 5]);
    source.totalOverride = 6;
    const out = await run(source);
    expect(out.outcome).toBe("incomplete");
    expect(store.snap?.completedAt).toBeNull();
    expect(store.snap?.crawlPage).toBe(0);
    expect(store.snap?.totalCount).toBe(6);
    expect(store.sweeps).toBe(0);
    const firstStart = store.snap?.crawlStartedAt;

    clock.advance(60_000);
    source.totalOverride = null;
    source.fetched = [];
    const again = await run(source);
    expect(source.fetched).toEqual([1, 2, 3]);
    expect(again.outcome).toBe("complete");
    expect(store.snap?.crawlStartedAt).not.toEqual(firstStart);
  });

  it("counts distinct rows, so a row repeated across pages is not double-counted", async () => {
    const source = new FakeSource([1, 2, 3]);
    source.onFetch = (p) =>
      p === 2
        ? { repos: [repo(2), repo(3)], totalCount: 3, hasNext: false }
        : undefined;
    expect((await run(source)).outcome).toBe("complete");
  });

  it("treats an empty page as the last page", async () => {
    const source = new FakeSource([1, 2]);
    source.onFetch = (p) =>
      p === 1
        ? { repos: [repo(1), repo(2)], totalCount: 2, hasNext: true }
        : { repos: [], totalCount: 2, hasNext: true };
    const out = await run(source);
    expect(source.fetched).toEqual([1, 2]);
    expect(out.outcome).toBe("complete");
  });
});

describe("crawlRepos: generation sweep", () => {
  it("never sweeps on a partial crawl", async () => {
    store.rows.set(99, { fullName: "acme/old", seenAt: new Date(0) });
    const source = new FakeSource([1, 2, 3, 4]);
    source.onFetch = (p) => {
      if (p === 2)
        throw new GithubLookupRateLimitError(
          new GithubEnterpriseError("rate_limit", "429"),
          new Date(T0.getTime() + 60_000),
        );
      return undefined;
    };
    await run(source);
    expect(store.sweeps).toBe(0);
    expect(store.rows.has(99)).toBe(true);
  });

  it("keeps rows added during the crawl and drops only the previous generation", async () => {
    store.rows.set(99, { fullName: "acme/old", seenAt: new Date(0) });
    const source = new FakeSource([1, 2, 3, 4]);
    source.onFetch = (p) => {
      clock.advance(1000);
      // A repo is created mid-crawl and lands on a page not yet read.
      if (p === 2) source.ids = [1, 2, 3, 4, 7];
      return undefined;
    };
    const out = await run(source);
    expect(out.outcome).toBe("complete");
    expect([...store.rows.keys()].sort()).toEqual([1, 2, 3, 4, 7]);
  });
});

describe("crawlRepos: rate limits", () => {
  it("records rateLimitResetAt and stops cleanly, without a failure", async () => {
    const reset = new Date(T0.getTime() + 15 * 60_000);
    const source = new FakeSource([1, 2, 3, 4, 5]);
    source.onFetch = (p) => {
      if (p === 2)
        throw new GithubLookupRateLimitError(
          new GithubEnterpriseError("rate_limit", "HTTP 429"),
          reset,
        );
      return undefined;
    };
    const out = await run(source);
    expect(out.outcome).toBe("rate_limited");
    expect(out.rateLimitResetAt).toEqual(reset);
    expect(store.snap?.rateLimitResetAt).toEqual(reset);
    expect(store.snap?.attempts).toBe(0);
    expect(store.snap?.lastError).toBeNull();
    expect(store.snap?.crawlPage).toBe(1);
  });

  it("uses Retry-After from a plain rate_limit error", async () => {
    const source = new FakeSource([1, 2, 3]);
    source.onFetch = () => {
      throw new GithubEnterpriseError("rate_limit", "HTTP 429", {
        status: 429,
        retryAfterSeconds: 30,
      });
    };
    const out = await run(source);
    expect(out.outcome).toBe("rate_limited");
    expect(store.snap?.rateLimitResetAt).toEqual(
      new Date(T0.getTime() + 30_000),
    );
  });

  it("stops after a successful page that exhausted the quota, keeping the page", async () => {
    const reset = new Date(T0.getTime() + 10 * 60_000);
    const source = new FakeSource([1, 2, 3, 4]);
    source.onFetch = (p) =>
      p === 1
        ? {
            repos: [repo(1), repo(2)],
            totalCount: 4,
            hasNext: true,
            rateLimit: { remaining: 0, resetAt: reset },
          }
        : undefined;
    const out = await run(source);
    expect(out.outcome).toBe("rate_limited");
    expect(source.fetched).toEqual([1]);
    expect(store.rows.size).toBe(2);
    expect(store.snap?.crawlPage).toBe(1);
    expect(store.snap?.rateLimitResetAt).toEqual(reset);
  });

  it("does not fetch before rateLimitResetAt, then resumes and clears it", async () => {
    const reset = new Date(T0.getTime() + 60_000);
    const source = new FakeSource([1, 2, 3, 4, 5]);
    source.onFetch = (p) => {
      if (p === 3)
        throw new GithubLookupRateLimitError(
          new GithubEnterpriseError("rate_limit", "HTTP 403"),
          reset,
        );
      return undefined;
    };
    await run(source);
    source.onFetch = null;
    source.fetched = [];

    clock.advance(30_000);
    const early = await run(source);
    expect(early.outcome).toBe("rate_limited");
    expect(source.fetched).toEqual([]);

    clock.advance(30_000);
    const late = await run(source);
    expect(late.outcome).toBe("complete");
    expect(source.fetched).toEqual([1, 2, 3]);
    expect(store.snap?.rateLimitResetAt).toBeNull();
  });

  it("records a plain permission error as a failure, not a rate limit", async () => {
    const source = new FakeSource([1, 2]);
    source.onFetch = () => {
      throw new GithubEnterpriseError("permission", "HTTP 403 not accessible");
    };
    const out = await run(source);
    expect(out.outcome).toBe("failed");
    expect(store.snap?.rateLimitResetAt).toBeNull();
    expect(store.snap?.attempts).toBe(1);
  });
});

describe("crawlRepos: page budget", () => {
  it("stops after maxPages with progress saved, and resumes with overlap", async () => {
    const source = new FakeSource([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = await crawlRepos({
      key: KEY,
      source,
      store,
      clock,
      maxPages: 2,
    });
    expect(out.outcome).toBe("in_progress");
    expect(store.snap?.crawlPage).toBe(2);
    source.fetched = [];
    const done = await run(source);
    expect(source.fetched).toEqual([1, 2, 3, 4]);
    expect(done.outcome).toBe("complete");
  });
});
