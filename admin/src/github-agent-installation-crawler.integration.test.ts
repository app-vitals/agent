/**
 * admin/src/github-agent-installation-crawler.integration.test.ts
 * The agent-installation crawl end to end through the installer client that
 * backs the installation port (lazyInstallerClient -> GithubEnterpriseClient),
 * replaying hand-authored cassettes (fixtures/github-agent-installation-cassette.json;
 * nothing recorded live) through an INJECTED fetchFn (no global fetch
 * override, no mock.module()). The repo list pages are generated here; the
 * cassette carries routes, headers and status codes. Persistence is an
 * in-memory CrawlStore (no database needed).
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  crawlAgentInstallation,
} from "./github-agent-installation-crawler.ts";
import { lazyInstallerClient } from "./github-installation-wiring.ts";
import type {
  CachedRepoInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";
import type { CrawlSnapshot, CrawlStore } from "./github-repo-crawler.ts";

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-agent-installation-cassette.json", import.meta.url)
      .pathname,
    "utf-8",
  ),
);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = new Date("2026-11-20T12:00:00Z");
const clock = { now: () => new Date(NOW) };
const ENT = "/enterprises/acme-ent";
const REPOS_501 = `${ENT}/apps/organizations/acme-eng/installations/501/repositories`;

class MemoryStore implements CrawlStore {
  snap: CrawlSnapshot | null = null;
  key: SnapshotKey | null = null;
  rows = new Map<number, { fullName: string; seenAt: Date }>();
  async getSnapshot(_k: SnapshotKey) {
    return this.snap ? { ...this.snap } : null;
  }
  async upsertSnapshot(k: SnapshotKey, p: SnapshotProgress = {}) {
    this.key = k;
    const next = {
      ...(this.snap ?? {
        id: "s1",
        crawlPage: 0,
        crawlStartedAt: null,
        completedAt: null,
        totalCount: null,
        lastError: null,
        attempts: 0,
        nextAttemptAt: null,
        rateLimitResetAt: null,
        lastTickAt: null,
      }),
    } as Record<string, unknown>;
    for (const [f, v] of Object.entries(p)) if (v !== undefined) next[f] = v;
    this.snap = next as unknown as CrawlSnapshot;
    return { ...this.snap };
  }
  async upsertRepos(_id: string, repos: CachedRepoInput[], seenAt: Date) {
    for (const r of repos) {
      this.rows.set(Number(r.githubId), { fullName: r.fullName, seenAt });
    }
    return repos.length;
  }
  async countReposSeenSince(_id: string, since: Date) {
    return [...this.rows.values()].filter((r) => r.seenAt >= since).length;
  }
  async sweepGeneration(_id: string) {
    const since = this.snap?.crawlStartedAt;
    let n = 0;
    for (const [id, r] of this.rows) {
      if (since && r.seenAt < since) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

/** `total` repos served in full pages of 100 with GitHub-style Link headers. */
function repoPage(total: number, page: number): CassetteEntry {
  const start = (page - 1) * 100;
  const n = Math.max(0, Math.min(100, total - start));
  const hasNext = start + 100 < total;
  return {
    status: 200,
    ...(hasNext
      ? { headers: { link: `<https://ghe.test/x?page=${page + 1}>; rel="next"` } }
      : {}),
    body: Array.from({ length: n }, (_, i) => ({
      id: start + i + 1,
      name: `r${start + i + 1}`,
      full_name: `acme-eng/r${start + i + 1}`,
      archived: (start + i + 1) % 50 === 0,
    })),
  };
}

function setup(opts: {
  installs: string;
  total?: number;
  repoOverride?: (page: number) => CassetteEntry | undefined;
}) {
  const paths: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const method = init?.method ?? "GET";
    paths.push(`${method} ${u.pathname}${u.search}`);
    let entry: CassetteEntry | undefined;
    if (u.pathname === `${ENT}/installation`) entry = cassette.enterprise_installation;
    else if (u.pathname === "/app/installations/4242/access_tokens") entry = cassette.installer_token;
    else if (u.pathname === `${ENT}/apps/organizations/acme-eng/installations` || u.pathname === `${ENT}/apps/organizations/beta-eng/installations`)
      entry = cassette[opts.installs];
    else if (u.pathname === REPOS_501) {
      const page = Number(u.searchParams.get("page"));
      entry = opts.repoOverride?.(page) ?? repoPage(opts.total ?? 0, page);
    }
    if (!entry) throw new Error(`no route for ${method} ${u.pathname}`);
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json", ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  const client = lazyInstallerClient({
    appService: {
      get: async () =>
        ({ appId: "12345", enterpriseSlug: "acme-ent" }) as never,
      getPrivateKey: async () => privateKey,
    },
    fetchFn,
    apiBase: "https://ghe.test",
    now: () => NOW,
  });
  return { client, paths, store: new MemoryStore() };
}

const agent = {
  accountId: "acc",
  appId: 777,
  clientId: "Iv1.agentapp0001",
  slug: "doc-agent",
};

describe("crawlAgentInstallation through the installer client (integration)", () => {
  it("crawls a multi-page installation to a complete snapshot", async () => {
    const { client, store, paths } = setup({
      installs: "org_installations_agent",
      total: 230,
    });
    const res = await crawlAgentInstallation({
      agent,
      org: "acme-eng",
      client,
      store,
      clock,
    });
    expect(res).toMatchObject({ outcome: "complete", pagesFetched: 3 });
    expect(store.rows.size).toBe(230);
    expect(store.snap).toMatchObject({ totalCount: 230, lastError: null });
    expect(store.snap?.completedAt).toEqual(NOW);
    expect(store.key).toEqual({
      accountId: "acc",
      appKind: "agent",
      appRef: "777",
      org: "acme-eng",
    });
    expect(paths.filter((p) => p.includes("/repositories"))).toEqual([
      `GET ${REPOS_501}?per_page=100&page=1`,
      `GET ${REPOS_501}?per_page=100&page=2`,
      `GET ${REPOS_501}?per_page=100&page=3`,
    ]);
  });

  it("handles an exact multiple of the page size (last page full, no next)", async () => {
    const { client, store } = setup({
      installs: "org_installations_agent",
      total: 200,
    });
    const res = await crawlAgentInstallation({
      agent,
      org: "acme-eng",
      client,
      store,
      clock,
    });
    expect(res.outcome).toBe("complete");
    expect(store.rows.size).toBe(200);
  });

  it("records an org without the agent App as not installed, sweeping stale rows", async () => {
    const { client, store, paths } = setup({
      installs: "org_installations_no_agent",
    });
    store.rows.set(1, { fullName: "beta-eng/old", seenAt: new Date(0) });
    const res = await crawlAgentInstallation({
      agent,
      org: "beta-eng",
      client,
      store,
      clock,
    });
    expect(res).toEqual({ outcome: "not_installed", pagesFetched: 0, swept: 1 });
    expect(store.snap?.lastError).toBeNull();
    expect(store.snap?.completedAt).toEqual(NOW);
    expect(paths.some((p) => p.includes("/repositories"))).toBe(false);
  });

  it("never crawls an agent without GH_APP_ID", async () => {
    const { client, store, paths } = setup({ installs: "org_installations_agent" });
    const res = await crawlAgentInstallation({
      agent: { accountId: "acc" },
      org: "acme-eng",
      client,
      store,
      clock,
    });
    expect(res.outcome).toBe("skipped_no_app_id");
    expect(paths).toEqual([]);
    expect(store.snap).toBeNull();
  });

  it("ends the run on a 429 with the retry-after reset recorded", async () => {
    const { client, store } = setup({
      installs: "org_installations_agent",
      total: 230,
      repoOverride: (page) =>
        page === 2 ? cassette.repos_rate_limited : undefined,
    });
    const res = await crawlAgentInstallation({
      agent,
      org: "acme-eng",
      client,
      store,
      clock,
    });
    expect(res.outcome).toBe("rate_limited");
    expect(res.pagesFetched).toBe(1);
    expect(store.snap?.rateLimitResetAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(store.snap?.attempts).toBe(0);
    expect(store.snap?.completedAt).toBeNull();
  });
});
