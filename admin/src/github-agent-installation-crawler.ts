/**
 * admin/src/github-agent-installation-crawler.ts
 * Crawl each agent App's own installation repos into the repo cache (GLC-1.5).
 *
 * A PageSource over the installer client's single-page installation listing,
 * fed through the same resumable engine (crawlRepos) and completeness check as
 * the lookup crawl, under appKind "agent" and appRef = the agent's GH_APP_ID.
 * Scheduling is not here (GLC-1.4).
 */

import type { Clock } from "./clock.ts";
import type { SnapshotKey } from "./github-repo-cache.ts";
import {
  type CrawlResult,
  type CrawlStore,
  crawlRepos,
  type PageSource,
  type RepoPage,
} from "./github-repo-crawler.ts";
import { identityOf } from "./installation-repos-service.ts";
import {
  AppNotInstalledError,
  type AppIdentity,
  type InstallationAgentRecord,
  type InstallationRepoClient,
  matchInstallation,
} from "./installation-ports.ts";

/**
 * SnapshotKey.accountId for an agent with no account (the deployment-wide
 * installer/App pair). The cache requires a non-empty accountId.
 */
export const DEPLOYMENT_WIDE_ACCOUNT_KEY = "deployment";

/** The slice of the installer client the crawl needs. */
export type AgentInstallationClient = Pick<
  InstallationRepoClient,
  "listOrgInstallations"
> &
  Required<Pick<InstallationRepoClient, "listInstallationRepositoriesPage">>;

export interface AgentInstallationPageSource extends PageSource {
  /** The agent App's installation id on the org; throws AppNotInstalledError. Cached. */
  resolveInstallationId(): Promise<number>;
}

export interface AgentInstallationSourceOptions {
  client: AgentInstallationClient;
  org: string;
  appId: number;
  identity?: AppIdentity;
}

/**
 * PageSource over the agent App's installation repositories on `org`. The
 * installation id is resolved lazily, once per source.
 *
 * The enterprise endpoint returns a bare array without total_count, so
 * totalCount is (page - 1) * perPage + repos.length: exact on the last page
 * because every earlier page is full. If rows duplicated or shifted between
 * pages, the engine sees fewer distinct rows than this total and marks the
 * crawl incomplete.
 */
export function agentInstallationPageSource(
  opts: AgentInstallationSourceOptions,
): AgentInstallationPageSource {
  const { client, org, appId, identity } = opts;
  let installationId: Promise<number> | undefined;
  const resolveInstallationId = (): Promise<number> => {
    installationId ??= client
      .listOrgInstallations(org, identity?.accountId)
      .then((installs) => {
        const found = matchInstallation(installs, appId, identity);
        if (!found) throw new AppNotInstalledError(appId, org);
        return found.id;
      });
    // Do not cache a failure: a later page or run may succeed.
    installationId.catch(() => {
      installationId = undefined;
    });
    return installationId;
  };
  return {
    resolveInstallationId,
    async fetchPage(page: number): Promise<RepoPage> {
      const id = await resolveInstallationId();
      const res = await client.listInstallationRepositoriesPage(
        org,
        id,
        page,
        identity?.accountId,
      );
      return {
        repos: res.repos.map((r) => ({
          githubId: r.id,
          fullName: r.fullName,
          archived: r.archived,
        })),
        totalCount: (page - 1) * res.perPage + res.repos.length,
        hasNext: res.hasNext,
      };
    },
  };
}

export type AgentInstallationCrawlResult =
  | CrawlResult
  /** The agent App has no installation on the org; recorded as an empty, complete snapshot. */
  | { outcome: "not_installed"; pagesFetched: 0; swept: number }
  /** The agent has no GH_APP_ID; nothing was read or written. */
  | { outcome: "skipped_no_app_id"; pagesFetched: 0 };

export interface CrawlAgentInstallationOptions {
  agent: Pick<
    InstallationAgentRecord,
    "accountId" | "appId" | "clientId" | "slug"
  >;
  org: string;
  client: AgentInstallationClient;
  store: CrawlStore;
  clock: Clock;
  maxPages?: number;
  backoffMs?: (attempts: number) => number;
}

/** Crawl one agent App's installation repos on one org into the cache. */
export async function crawlAgentInstallation(
  opts: CrawlAgentInstallationOptions,
): Promise<AgentInstallationCrawlResult> {
  const { agent, org, client, store, clock } = opts;
  if (agent.appId === undefined) {
    return { outcome: "skipped_no_app_id", pagesFetched: 0 };
  }
  const key: SnapshotKey = {
    accountId: agent.accountId || DEPLOYMENT_WIDE_ACCOUNT_KEY,
    appKind: "agent",
    appRef: String(agent.appId),
    org,
  };
  const source = agentInstallationPageSource({
    client,
    org,
    appId: agent.appId,
    identity: identityOf(agent),
  });
  try {
    await source.resolveInstallationId();
  } catch (err) {
    if (!(err instanceof AppNotInstalledError)) {
      // Let the engine record GitHub failures and rate limits on the snapshot.
      return crawlRepos({ ...engineOpts(), key, source });
    }
    // Not installed: an empty, complete snapshot (stale rows swept), no error.
    const now = clock.now();
    const snap = await store.upsertSnapshot(key, {
      crawlStartedAt: now,
      crawlPage: 0,
      completedAt: now,
      totalCount: 0,
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
      rateLimitResetAt: null,
      lastTickAt: now,
    });
    const swept = await store.sweepGeneration(snap.id);
    return { outcome: "not_installed", pagesFetched: 0, swept };
  }
  return crawlRepos({ ...engineOpts(), key, source });

  function engineOpts() {
    return {
      store,
      clock,
      ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
      ...(opts.backoffMs === undefined ? {} : { backoffMs: opts.backoffMs }),
    };
  }
}
