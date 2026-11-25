/**
 * admin/src/github-agent-installation-crawler.unit.test.ts
 * Unit tests for the agent-App installation PageSource and the
 * crawlAgentInstallation orchestrator, against fake pages and an in-memory
 * CrawlStore.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  agentInstallationPageSource,
  crawlAgentInstallation,
  DEPLOYMENT_WIDE_ACCOUNT_KEY,
  lookupAccountKeys,
  type AgentInstallationClient,
} from "./github-agent-installation-crawler.ts";
import type {
  CachedRepoInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";
import type { CrawlSnapshot, CrawlStore } from "./github-repo-crawler.ts";
import { AppNotInstalledError } from "./installation-ports.ts";

const T0 = new Date("2026-11-20T12:00:00Z");
const clock = { now: () => new Date(T0) };

class MemoryStore implements CrawlStore {
  keys: SnapshotKey[] = [];
  snap: CrawlSnapshot | null = null;
  rows = new Map<number, { fullName: string; seenAt: Date }>();
  async getSnapshot(key: SnapshotKey) {
    this.keys.push(key);
    return this.snap ? { ...this.snap } : null;
  }
  async upsertSnapshot(key: SnapshotKey, progress: SnapshotProgress = {}) {
    this.keys.push(key);
    const base: CrawlSnapshot = this.snap ?? {
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
    };
    const next = { ...base } as Record<string, unknown>;
    for (const [k, v] of Object.entries(progress)) {
      if (v !== undefined) next[k] = v;
    }
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

interface FakeClientOpts {
  installs?: {
    id: number;
    appId?: number;
    appSlug?: string;
    clientId?: string;
    repositorySelection?: "all" | "selected" | "none";
  }[];
  total?: number;
  perPage?: number;
  failPage?: (page: number) => Error | undefined;
}

function fakeClient(o: FakeClientOpts = {}) {
  const perPage = o.perPage ?? 2;
  const total = o.total ?? 5;
  const calls = { installs: 0, pages: [] as number[] };
  const client: AgentInstallationClient = {
    async listOrgInstallations() {
      calls.installs++;
      return o.installs ?? [{ id: 501, appId: 777 }];
    },
    async listInstallationRepositoriesPage(_org, installationId, page) {
      expect(installationId).toBe(501);
      calls.pages.push(page);
      const err = o.failPage?.(page);
      if (err) throw err;
      const start = (page - 1) * perPage;
      const ids = Array.from({ length: total }, (_, i) => i + 1).slice(
        start,
        start + perPage,
      );
      return {
        repos: ids.map((id) => ({ id, fullName: `acme/r${id}` })),
        hasNext: start + perPage < total,
        perPage,
      };
    },
  };
  return { client, calls };
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  accountId: "acc",
  appId: 777,
  ...over,
});

describe("agentInstallationPageSource", () => {
  it("maps a page and reports totalCount from the page position", async () => {
    const { client } = fakeClient({ total: 5 });
    const src = agentInstallationPageSource({
      client,
      org: "acme",
      appId: 777,
    });
    const p1 = await src.fetchPage(1);
    expect(p1.repos.map((r) => r.fullName)).toEqual(["acme/r1", "acme/r2"]);
    expect(p1.hasNext).toBe(true);
    const p3 = await src.fetchPage(3);
    // (3-1)*2 + 1 row on the last page
    expect(p3.totalCount).toBe(5);
    expect(p3.hasNext).toBe(false);
  });

  it("carries archived through to the cache input", async () => {
    const src = agentInstallationPageSource({
      client: {
        listOrgInstallations: async () => [{ id: 501, appId: 777 }],
        listInstallationRepositoriesPage: async () => ({
          repos: [{ id: 9, fullName: "acme/x", archived: true }],
          hasNext: false,
          perPage: 100,
        }),
      },
      org: "acme",
      appId: 777,
    });
    expect((await src.fetchPage(1)).repos).toEqual([
      { githubId: 9, fullName: "acme/x", archived: true },
    ]);
  });

  it("resolves the installation once and caches it", async () => {
    const { client, calls } = fakeClient();
    const src = agentInstallationPageSource({ client, org: "acme", appId: 777 });
    await src.fetchPage(1);
    await src.fetchPage(2);
    await src.resolveInstallationId();
    expect(calls.installs).toBe(1);
  });

  it("matches by identity (client id) before app id", async () => {
    const { client } = fakeClient({
      installs: [
        { id: 900, appId: 777, clientId: "Iv1.other" },
        { id: 501, clientId: "Iv1.mine" },
      ],
    });
    const src = agentInstallationPageSource({
      client,
      org: "acme",
      appId: 777,
      identity: { clientId: "Iv1.mine" },
    });
    expect(await src.resolveInstallationId()).toBe(501);
  });

  it("throws AppNotInstalledError when no installation matches", async () => {
    const { client } = fakeClient({ installs: [{ id: 1, appId: 5 }] });
    const src = agentInstallationPageSource({ client, org: "acme", appId: 777 });
    await expect(src.fetchPage(1)).rejects.toBeInstanceOf(AppNotInstalledError);
  });
});

describe("crawlAgentInstallation", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("crawls under appKind agent with appRef = String(appId)", async () => {
    const { client } = fakeClient({ total: 5 });
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(res.outcome).toBe("complete");
    expect(store.keys[0]).toEqual({
      accountId: "acc",
      appKind: "agent",
      appRef: "777",
      org: "acme",
    });
    expect(store.rows.size).toBe(5);
    expect(store.snap?.completedAt).not.toBeNull();
  });

  it("uses the deployment-wide key when the agent has no account", async () => {
    const { client } = fakeClient();
    await crawlAgentInstallation({
      agent: agent({ accountId: null }),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(store.keys[0]?.accountId).toBe(DEPLOYMENT_WIDE_ACCOUNT_KEY);
  });

  it("is incomplete (engine completeness check) when rows shift mid-crawl", async () => {
    const { client } = fakeClient({ total: 5 });
    const dup: AgentInstallationClient = {
      listOrgInstallations: client.listOrgInstallations,
      async listInstallationRepositoriesPage(org, id, page) {
        const res = await client.listInstallationRepositoriesPage(org, id, page);
        // page 2 repeats a row from page 1 and loses its own
        return page === 2
          ? { ...res, repos: [res.repos[0], { id: 1, fullName: "acme/r1" }].filter((r): r is NonNullable<typeof r> => !!r) }
          : res;
      },
    };
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client: dup,
      store,
      clock,
    });
    expect(res.outcome).toBe("incomplete");
    expect(store.snap?.completedAt).toBeNull();
  });

  it("resumes: a second run continues from the saved page", async () => {
    const { client, calls } = fakeClient({ total: 5 });
    const first = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
      maxPages: 1,
    });
    expect(first.outcome).toBe("in_progress");
    const second = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(second.outcome).toBe("complete");
    expect(calls.pages).toEqual([1, 1, 2, 3]);
  });

  it("passes shouldStop through to the engine", async () => {
    const { client, calls } = fakeClient({ total: 5 });
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
      shouldStop: () => true,
    });
    expect(res.outcome).toBe("in_progress");
    expect(calls.pages).toEqual([1]);
  });

  it("records not-installed as a completed empty snapshot, not an error", async () => {
    store.rows.set(1, { fullName: "acme/stale", seenAt: new Date(0) });
    const { client, calls } = fakeClient({ installs: [] });
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(res).toEqual({ outcome: "not_installed", pagesFetched: 0, swept: 1 });
    expect(calls.pages).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(store.snap).toMatchObject({
      totalCount: 0,
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
    });
    expect(store.snap?.completedAt).toEqual(T0);
  });

  it("skips agents without GH_APP_ID and never touches the store or client", async () => {
    const { client, calls } = fakeClient();
    const res = await crawlAgentInstallation({
      agent: agent({ appId: undefined }),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(res).toEqual({ outcome: "skipped_no_app_id", pagesFetched: 0 });
    expect(store.keys).toEqual([]);
    expect(calls.installs).toBe(0);
  });

  it("ends the run cleanly on a rate limit", async () => {
    const { client } = fakeClient({
      failPage: () =>
        new GithubEnterpriseError("rate_limit", "slow down", {
          status: 429,
          retryAfterSeconds: 30,
        }),
    });
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(res).toMatchObject({
      outcome: "rate_limited",
      rateLimitResetAt: new Date(T0.getTime() + 30_000),
    });
    expect(store.snap?.attempts).toBe(0);
  });

  it("records a GitHub failure as failed", async () => {
    const { client } = fakeClient({
      failPage: () => new GithubEnterpriseError("server", "boom"),
    });
    const res = await crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
    expect(res.outcome).toBe("failed");
    expect(store.snap?.attempts).toBe(1);
  });
});

describe("lookupAccountKeys", () => {
  it("a deployment-wide agent (no account) reads only the deployment key", () => {
    expect(lookupAccountKeys(null)).toEqual([DEPLOYMENT_WIDE_ACCOUNT_KEY]);
    expect(lookupAccountKeys(undefined)).toEqual([DEPLOYMENT_WIDE_ACCOUNT_KEY]);
    expect(lookupAccountKeys("")).toEqual([DEPLOYMENT_WIDE_ACCOUNT_KEY]);
  });

  it("an account agent reads its own account and the deployment key", () => {
    expect(lookupAccountKeys("acct")).toEqual([
      "acct",
      DEPLOYMENT_WIDE_ACCOUNT_KEY,
    ]);
  });

  it("never includes the empty-string key", () => {
    expect(lookupAccountKeys(null)).not.toContain("");
    expect(lookupAccountKeys("acct")).not.toContain("");
  });
});

describe("crawlAgentInstallation repository selection (GIS-1.1)", () => {
  const run = (store: MemoryStore, client: AgentInstallationClient) =>
    crawlAgentInstallation({
      agent: agent(),
      org: "acme",
      client,
      store,
      clock,
    });
  const selection = (store: MemoryStore) =>
    (store.snap as unknown as Record<string, unknown> | null)
      ?.repositorySelection;

  it.each(["all", "selected"] as const)("records %s", async (value) => {
    const store = new MemoryStore();
    const { client } = fakeClient({
      installs: [{ id: 501, appId: 777, repositorySelection: value }],
    });
    await run(store, client);
    expect(selection(store)).toBe(value);
  });

  it("records null when the listing omits it or says none", async () => {
    for (const repositorySelection of [undefined, "none" as const]) {
      const store = new MemoryStore();
      const { client } = fakeClient({
        installs: [{ id: 501, appId: 777, repositorySelection }],
      });
      await run(store, client);
      expect(selection(store)).toBeNull();
    }
  });

  it("clears a previous value when the App is not installed", async () => {
    const store = new MemoryStore();
    await run(
      store,
      fakeClient({
        installs: [{ id: 501, appId: 777, repositorySelection: "all" }],
      }).client,
    );
    expect(selection(store)).toBe("all");
    const res = await run(store, fakeClient({ installs: [] }).client);
    expect(res.outcome).toBe("not_installed");
    expect(selection(store)).toBeNull();
  });

  it("keeps the previous value when listing installations fails", async () => {
    const store = new MemoryStore();
    await run(
      store,
      fakeClient({
        installs: [{ id: 501, appId: 777, repositorySelection: "selected" }],
      }).client,
    );
    const failing: AgentInstallationClient = {
      async listOrgInstallations() {
        throw new GithubEnterpriseError("server", "boom");
      },
      async listInstallationRepositoriesPage() {
        throw new GithubEnterpriseError("server", "boom");
      },
    };
    const res = await run(store, failing);
    expect(res.outcome).toBe("failed");
    expect(selection(store)).toBe("selected");
  });
});
