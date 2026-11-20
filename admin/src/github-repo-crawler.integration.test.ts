/**
 * admin/src/github-repo-crawler.integration.test.ts
 * The crawl engine end to end: GithubLookupClient replaying hand-authored
 * cassettes (fixtures/github-lookup-cassette.json) through an INJECTED fetchFn
 * (no global fetch override, no mock.module()), persisting through
 * GitHubRepoCacheService into a real PostgreSQL DB.
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../prisma/client/client.ts";
import { GithubLookupClient } from "./github-lookup-client.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { crawlRepos, lookupRepoPageSource } from "./github-repo-crawler.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-lookup-cassette.json", import.meta.url).pathname,
    "utf-8",
  ),
);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const T0 = new Date("2026-11-09T12:00:00Z");
const RESET = new Date("2026-11-09T12:15:00Z");
const key = {
  accountId: "acc",
  appKind: "lookup" as const,
  appRef: "555",
  org: "acme-eng",
};

describeOrSkip("crawlRepos through GithubLookupClient (integration)", () => {
  let prisma: PrismaClient;
  let now: Date;
  let svc: GitHubRepoCacheService;
  /** Repo listing route per page number -> cassette key. */
  let pages: Record<number, string>;
  let fetchedPages: number[];
  let client: GithubLookupClient;

  const clock = { now: () => new Date(now) };
  const run = () =>
    crawlRepos({
      key,
      source: lookupRepoPageSource(client, "acme-eng"),
      store: svc,
      clock,
    });
  const names = async () =>
    (
      await prisma.gitHubCachedRepo.findMany({ orderBy: { githubId: "asc" } })
    ).map((r) => r.fullName);

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    now = T0;
    svc = new GitHubRepoCacheService(prisma, clock);
    pages = { 1: "repos_page_1", 2: "repos_page_2" };
    fetchedPages = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(init?.signal instanceof AbortSignal)) {
        throw new Error("request made without a timeout signal");
      }
      const u = new URL(input.toString());
      const route = `${init?.method ?? "GET"} ${u.pathname}`;
      let name: string | undefined;
      if (route === "GET /orgs/acme-eng/installation") {
        name = "org_installation_success";
      } else if (route === "POST /app/installations/7001/access_tokens") {
        name = "lookup_token_success";
      } else if (route === "GET /installation/repositories") {
        const page = Number(u.searchParams.get("page"));
        fetchedPages.push(page);
        name = pages[page];
      }
      const entry = name ? cassette[name] : undefined;
      if (!entry) throw new Error(`no cassette for ${route}${u.search}`);
      return new Response(JSON.stringify(entry.body), {
        status: entry.status,
        headers: {
          "Content-Type": "application/json",
          ...(entry.headers ?? {}),
        },
      });
    }) as typeof fetch;
    client = new GithubLookupClient({
      appId: "555",
      privateKey,
      apiBase: "https://ghe.test",
      fetchFn,
      now: clock.now,
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("crawls every page, completes, and sweeps repos gone since the last crawl", async () => {
    const snap = await svc.upsertSnapshot(key);
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 99, fullName: "acme-eng/deleted" }],
      new Date(T0.getTime() - 86_400_000),
    );
    const out = await run();
    expect(out).toEqual({ outcome: "complete", pagesFetched: 2, swept: 1 });
    expect(await names()).toEqual([
      "acme-eng/api",
      "acme-eng/web",
      "acme-eng/infra",
    ]);
    const after = await svc.getSnapshot(key);
    expect(after?.completedAt).toEqual(T0);
    expect(after?.crawlStartedAt).toEqual(T0);
    expect(after?.totalCount).toBe(3);
    expect(after?.crawlPage).toBe(2);
  });

  it("resumes after a mid-crawl failure from the saved page minus one, without duplicates", async () => {
    pages[2] = "repos_500";
    const first = await run();
    expect(first.outcome).toBe("failed");
    let snap = await svc.getSnapshot(key);
    expect(snap?.crawlPage).toBe(1);
    expect(snap?.attempts).toBe(1);
    expect(snap?.lastError).toContain("HTTP 500");
    expect(snap?.completedAt).toBeNull();

    now = new Date(T0.getTime() + 60_000);
    pages[2] = "repos_page_2";
    fetchedPages = [];
    const second = await run();
    expect(second.outcome).toBe("complete");
    expect(fetchedPages).toEqual([1, 2]);
    expect(await prisma.gitHubCachedRepo.count()).toBe(3);
    snap = await svc.getSnapshot(key);
    expect(snap?.crawlStartedAt).toEqual(T0);
    expect(snap?.completedAt).toEqual(now);
    expect(snap?.attempts).toBe(0);
  });

  it("leaves completedAt unset on a total_count mismatch and restarts from page 1", async () => {
    pages[2] = "repos_page_2_total_mismatch";
    const out = await run();
    expect(out.outcome).toBe("incomplete");
    let snap = await svc.getSnapshot(key);
    expect(snap?.completedAt).toBeNull();
    expect(snap?.crawlPage).toBe(0);
    expect(snap?.totalCount).toBe(4);

    now = new Date(T0.getTime() + 60_000);
    pages[2] = "repos_page_2";
    fetchedPages = [];
    expect((await run()).outcome).toBe("complete");
    expect(fetchedPages).toEqual([1, 2]);
    snap = await svc.getSnapshot(key);
    expect(snap?.crawlStartedAt).toEqual(now);
  });

  it("stops on a 429 with rateLimitResetAt and no failure, keeping saved pages unswept", async () => {
    const snap0 = await svc.upsertSnapshot(key);
    await svc.upsertRepos(
      snap0.id,
      [{ githubId: 99, fullName: "acme-eng/older" }],
      new Date(T0.getTime() - 1000),
    );
    pages[2] = "repos_429";
    const out = await run();
    expect(out.outcome).toBe("rate_limited");
    expect(out.rateLimitResetAt).toEqual(new Date(T0.getTime() + 30_000));
    const snap = await svc.getSnapshot(key);
    expect(snap?.rateLimitResetAt).toEqual(new Date(T0.getTime() + 30_000));
    expect(snap?.attempts).toBe(0);
    expect(snap?.lastError).toBeNull();
    expect(snap?.crawlPage).toBe(1);
    expect(await names()).toEqual([
      "acme-eng/api",
      "acme-eng/web",
      "acme-eng/older",
    ]);
  });

  it("stops after a page that exhausted the quota, then resumes after the reset", async () => {
    pages[1] = "repos_page_1_rate_limit_exhausted";
    const out = await run();
    expect(out.outcome).toBe("rate_limited");
    expect(out.rateLimitResetAt).toEqual(RESET);
    expect(fetchedPages).toEqual([1]);
    expect(await prisma.gitHubCachedRepo.count()).toBe(2);

    now = new Date(RESET.getTime() - 1000);
    fetchedPages = [];
    expect((await run()).outcome).toBe("rate_limited");
    expect(fetchedPages).toEqual([]);

    now = RESET;
    pages[1] = "repos_page_1";
    expect((await run()).outcome).toBe("complete");
    expect(fetchedPages).toEqual([1, 2]);
    expect(await prisma.gitHubCachedRepo.count()).toBe(3);
    const snap = await svc.getSnapshot(key);
    expect(snap?.rateLimitResetAt).toBeNull();
    expect(snap?.crawlStartedAt).toEqual(T0);
  });

  it("treats a primary-limit 403 as a rate limit using X-RateLimit-Reset", async () => {
    pages[1] = "repos_403_rate_limited";
    const out = await run();
    expect(out.outcome).toBe("rate_limited");
    expect((await svc.getSnapshot(key))?.rateLimitResetAt).toEqual(RESET);
  });

  it("countReposSeenSince counts only rows seen at or after the cutoff", async () => {
    const snap = await svc.upsertSnapshot(key);
    await svc.upsertRepos(snap.id, [{ githubId: 1, fullName: "a/1" }], T0);
    await svc.upsertRepos(
      snap.id,
      [{ githubId: 2, fullName: "a/2" }],
      new Date(T0.getTime() - 1),
    );
    expect(await svc.countReposSeenSince(snap.id, T0)).toBe(1);
  });
});
