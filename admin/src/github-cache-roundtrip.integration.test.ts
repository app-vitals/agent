/**
 * admin/src/github-cache-roundtrip.integration.test.ts
 * Real-database round trip for the GitHub repo cache (GFU-1.1). The real
 * refresher, discovery and crawlers write snapshots and access rows through
 * GitHubRepoCacheService into PostgreSQL, and every reader reads them back:
 * githubLookup.listRepositories, GitHub Sync preview (lookupRepos plus
 * cachedAccess) and the installation repos list.
 *
 * Earlier tests stubbed lookupRepos or the cache, which hid readers that
 * looked under the wrong account key (GSF-1.1, GSF-4.1). Only the GitHub
 * ports are faked here (lookup client, installer client); time is an injected
 * Clock. Two scopes: a deployment-wide (null-account) lookup App, filed under
 * DEPLOYMENT_WIDE_ACCOUNT_KEY, and an account-scoped App, read through its own
 * account key plus the deployment key (lookupAccountKeys).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { Clock } from "./clock.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import { createGithubLookupService } from "./github-enterprise-api.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import {
  createGithubInstallationRepos,
  createGithubSync,
} from "./github-installation-wiring.ts";
import {
  DEPLOYMENT_WIDE_ACCOUNT_KEY,
  lookupAccountKeys,
} from "./github-agent-installation-crawler.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import {
  createRefreshDiscovery,
  type LookupAppClient,
} from "./github-repo-refresh-discovery.ts";
import { GithubRepoRefresher } from "./github-repo-refresher.ts";
import {
  createInstallationPort,
  type InstallationRepoClient,
} from "./installation-ports.ts";
import { createInstallationReposPort } from "./installation-repos-service.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const T0 = new Date("2026-11-20T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const LOOKUP_APP_ID = "555";
const AGENT_APP_ID = 42;
const USERNAME = "octocat";

/** Repos per org: three, listed over two pages (two per page). */
const reposOf = (org: string) => ["a", "b", "c"].map((n) => `${org}/${n}`);

/** Fake lookup App client: the GitHub port the crawl and access backfill use. */
function fakeLookupClient(orgs: string[]): LookupAppClient {
  return {
    async listInstallations() {
      return orgs.map((login, i) => ({
        id: i + 1,
        login,
      })) as unknown as Awaited<
        ReturnType<LookupAppClient["listInstallations"]>
      >;
    },
    async listInstallationRepositoriesPage(org, page) {
      const all = reposOf(org);
      const slice = all.slice((page - 1) * 2, page * 2);
      return {
        repositories: slice.map((fullName) => ({
          id: org.length * 1000 + all.indexOf(fullName) + 1,
          fullName,
          archived: false,
        })),
        totalCount: all.length,
        hasNext: page * 2 < all.length,
        rateLimit: { remaining: 4000, resetAt: null, retryAfterSeconds: null },
      } as unknown as Awaited<
        ReturnType<LookupAppClient["listInstallationRepositoriesPage"]>
      >;
    },
    async getCollaboratorPermissionWithRateLimit(_org, repo) {
      return {
        role: repo === "a" ? "write" : "read",
        rateLimit: { remaining: 4000, resetAt: null, retryAfterSeconds: null },
      };
    },
  };
}

type InstallerClient = InstallationRepoClient &
  Required<Pick<InstallationRepoClient, "listInstallationRepositoriesPage">> & {
    listInstallableOrganizations(): Promise<{ login: string }[]>;
  };

/** Fake installer client: the agent App has installation 900 on org `acme`. */
function fakeInstaller(): InstallerClient {
  const repos = (org: string) =>
    reposOf(org).map((fullName, i) => ({
      id: 9000 + i,
      fullName,
      archived: false,
    }));
  return {
    async listInstallableOrganizations() {
      return [{ login: "acme" }];
    },
    async listOrgInstallations() {
      return [{ id: 900, appId: AGENT_APP_ID }];
    },
    async listInstallationRepositories(org: string) {
      return repos(org);
    },
    async listInstallationRepositoriesPage(
      org: string,
      _id: number,
      page: number,
    ) {
      const all = repos(org);
      const slice = all.slice((page - 1) * 2, page * 2);
      return {
        repos: slice,
        perPage: 2,
        hasNext: page * 2 < all.length,
      };
    },
    async addRepositories() {},
    async removeRepositories() {},
  } as unknown as InstallerClient;
}

describeOrSkip("GitHub repo cache round trip (integration)", () => {
  let prisma: PrismaClient;
  let now: Date;
  let cache: GitHubRepoCacheService;
  const accountIds: string[] = [];
  const agentIds: string[] = [];

  const clock: Clock = { now: () => new Date(now) };

  const agentEnv = {
    getConfigBundle: async () => ({ env: { GH_APP_ID: String(AGENT_APP_ID) } }),
  } as unknown as Pick<AgentEnvService, "getConfigBundle">;

  /** Resolves a lookup App per scope, as the stored-App wiring would. */
  interface Apps {
    /** scope (null = deployment-wide) -> the App row that scope resolves to. */
    byScope: Map<
      string | null,
      { ownerAccountId: string | null; orgs: string[] }
    >;
  }

  const appService = (apps: Apps) =>
    ({
      get: async (role: string, scope?: string | null) => {
        if (role !== "lookup") return null;
        const found = apps.byScope.get(scope ?? null);
        if (!found) return null;
        return {
          appId: LOOKUP_APP_ID,
          accountId: found.ownerAccountId,
          enterpriseSlug: null,
          updatedAt: T0,
        };
      },
      getPrivateKey: async (role: string, scope?: string | null) =>
        role === "lookup" && apps.byScope.has(scope ?? null) ? "pem" : null,
    }) as unknown as GitHubEnterpriseAppService;

  /** Run the real refresher until every target is crawled and backfilled. */
  async function refresh(apps: Apps, agentScope: string | null) {
    const installer = fakeInstaller();
    const { PrismaInstallationAgents } = await import(
      "./installation-ports.ts"
    );
    const agentsPort = new PrismaInstallationAgents(prisma, agentEnv);
    const discovery = createRefreshDiscovery({
      listAppScopes: async () =>
        [...apps.byScope.keys()].filter((s): s is string => s !== null),
      async listAgents() {
        const out = [];
        for (const id of agentIds) {
          const rec = await agentsPort.get(id);
          if (rec) out.push(rec);
        }
        return out;
      },
      async lookupApp(scope) {
        const found = apps.byScope.get(scope);
        if (!found) return null;
        return {
          accountId: found.ownerAccountId,
          appId: LOOKUP_APP_ID,
          client: fakeLookupClient(found.orgs),
        };
      },
      // Only the agent's own scope has an installer; the others fall back to
      // the lookup App's own installations for their orgs.
      installerOrgs: async (scope) => (scope === agentScope ? ["acme"] : null),
      installer,
      store: cache,
      clock,
      log: () => {},
    });
    const refresher = new GithubRepoRefresher({
      discovery,
      store: cache,
      clock,
      holder: "roundtrip",
      config: {
        intervalMs: MINUTE,
        ttlMs: HOUR,
        stalenessCapMs: 6 * HOUR,
        timeBudgetMs: 45_000,
      },
      log: () => {},
    });
    const result = await refresher.tick();
    expect(result.targets.every((t) => t.state === "worked")).toBe(true);
    // Readers run a little later, still inside the freshness window.
    now = new Date(T0.getTime() + MINUTE);
    return installer;
  }

  async function makeAgent(accountId: string | null) {
    const agent = await prisma.agent.create({
      data: {
        name: `roundtrip-${agentIds.length}`,
        githubUsername: USERNAME,
        repos: ["acme/a"],
        ...(accountId ? { accountId } : {}),
      },
    });
    agentIds.push(agent.id);
    return agent.id;
  }

  async function makeAccount(name: string) {
    const acct = await prisma.account.create({ data: { name } });
    accountIds.push(acct.id);
    return acct.id;
  }

  const lister = (apps: Apps) =>
    createGithubLookupService({
      appService: appService(apps),
      cache,
      now: () => clock.now(),
    });

  const noLiveAccess: GithubAccessPreviewFn = async () => {
    throw new Error("the live access resolver must not be consulted");
  };

  const wiring = (apps: Apps, installer: InstallerClient) => {
    const installationRepos = createInstallationReposPort(
      createInstallationPort(installer),
      installer,
    );
    return {
      prisma,
      appService: appService(apps),
      access: noLiveAccess,
      agentEnv,
      installationRepos,
      now: () => clock.now(),
    };
  };

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubRepoAccess.deleteMany();
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    now = T0;
    cache = new GitHubRepoCacheService(prisma, clock);
    accountIds.length = 0;
    agentIds.length = 0;
  });

  afterEach(async () => {
    await prisma.gitHubRepoAccess.deleteMany();
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    if (agentIds.length > 0) {
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  it("null-account lookup App: every reader reads the deployment-keyed snapshots", async () => {
    const agentId = await makeAgent(null);
    const apps: Apps = {
      byScope: new Map([[null, { ownerAccountId: null, orgs: ["acme"] }]]),
    };
    const installer = await refresh(apps, null);

    // The writers filed everything under the deployment key.
    const snaps = await prisma.gitHubRepoSnapshot.findMany();
    expect(snaps.map((s) => [s.appKind, s.accountId, s.org]).sort()).toEqual([
      ["agent", DEPLOYMENT_WIDE_ACCOUNT_KEY, "acme"],
      ["lookup", DEPLOYMENT_WIDE_ACCOUNT_KEY, "acme"],
    ]);

    // 1. githubLookup.listRepositories
    const listed = await lister(apps).listRepositories(null);
    expect(listed.configured).toBe(true);
    expect(listed.syncState).toBe("ready");
    expect(listed.repos.map((r) => r.fullName).sort()).toEqual(reposOf("acme"));

    // 2. Sync preview: lookupRepos + cachedAccess over the real cache.
    const sync = createGithubSync(wiring(apps, installer));
    const preview = await sync.preview(agentId);
    if (preview.status !== "previewed") throw new Error(preview.status);
    expect(preview.plan.skippedOrgs).toEqual([]);
    expect(preview.plan.appRemoves).toEqual(["acme/b", "acme/c"]);

    // 3. Installation list: the agent App snapshot.
    const list = await createGithubInstallationRepos(
      wiring(apps, installer),
    ).list(agentId);
    if (list.status !== "ok") throw new Error(list.status);
    expect(list.appId).toBe(AGENT_APP_ID);
    expect(list.orgs).toHaveLength(1);
    expect(list.orgs[0]?.org).toBe("acme");
    expect(list.orgs[0]?.complete).toBe(true);
    expect(list.orgs[0]?.repos.map((r) => r.fullName).sort()).toEqual(
      reposOf("acme"),
    );
  });

  it("account-scoped App: readers use the own account key plus the deployment key, never another account's", async () => {
    const acct = await makeAccount("roundtrip-own");
    const other = await makeAccount("roundtrip-other");
    const agentId = await makeAgent(acct);
    const apps: Apps = {
      byScope: new Map([
        // The account's own App covers `acme`; the deployment-wide App `beta`.
        [acct, { ownerAccountId: acct, orgs: ["acme"] }],
        [null, { ownerAccountId: null, orgs: ["beta"] }],
        // Another account's App, same App id, must never be read.
        [other, { ownerAccountId: other, orgs: ["evil"] }],
      ]),
    };
    const installer = await refresh(apps, acct);

    expect(lookupAccountKeys(acct)).toEqual([
      acct,
      DEPLOYMENT_WIDE_ACCOUNT_KEY,
    ]);
    const lookupSnaps = await prisma.gitHubRepoSnapshot.findMany({
      where: { appKind: "lookup" },
    });
    expect(lookupSnaps.map((s) => [s.accountId, s.org]).sort()).toEqual(
      [
        [acct, "acme"],
        [DEPLOYMENT_WIDE_ACCOUNT_KEY, "beta"],
        [other, "evil"],
      ].sort(),
    );

    // 1. Lister: own account's acme plus the deployment-wide beta, no evil.
    const listed = await lister(apps).listRepositories(acct);
    expect(listed.configured).toBe(true);
    expect(listed.syncState).toBe("ready");
    expect(listed.repos.map((r) => r.fullName).sort()).toEqual(
      [...reposOf("acme"), ...reposOf("beta")].sort(),
    );
    expect(listed.repos.some((r) => r.fullName.startsWith("evil/"))).toBe(
      false,
    );

    // The other account's lister sees its own org plus the deployment key only.
    const otherListed = await lister(apps).listRepositories(other);
    expect(otherListed.repos.map((r) => r.fullName).sort()).toEqual(
      [...reposOf("evil"), ...reposOf("beta")].sort(),
    );

    // 2. Sync preview over the account's own access rows.
    const sync = createGithubSync(wiring(apps, installer));
    const preview = await sync.preview(agentId);
    if (preview.status !== "previewed") throw new Error(preview.status);
    expect(preview.plan.skippedOrgs).toEqual([]);
    expect(preview.plan.appRemoves).toEqual(["acme/b", "acme/c"]);

    // 3. Installation list: the agent App snapshot under the account key.
    const list = await createGithubInstallationRepos(
      wiring(apps, installer),
    ).list(agentId);
    if (list.status !== "ok") throw new Error(list.status);
    expect(list.orgs).toHaveLength(1);
    expect(list.orgs[0]?.org).toBe("acme");
    expect(list.orgs[0]?.complete).toBe(true);
    expect(list.orgs[0]?.repos.map((r) => r.fullName).sort()).toEqual(
      reposOf("acme"),
    );
  });
});
