/**
 * admin/src/github-repo-refresh-discovery.ts
 * Target discovery for the refresh tick (GLC-1.4): which cache snapshots to
 * keep current, from the stored GitHub Apps, the installer App's orgs and the
 * agents.
 *
 * Scopes are the deployment-wide App pair plus every account with Apps of its
 * own. Per scope, the resolved lookup App (the account's, else the
 * deployment-wide one, as listRepositories resolves it) gets one lookup target
 * per org, keyed by the scope that owns the lookup App (accountId, or
 * DEPLOYMENT_WIDE_ACCOUNT_KEY). Orgs come from the resolved installer App when
 * it has an enterprise slug, else from the lookup App's own installations.
 * Agents with a GH_APP_ID and a GitHub username whose account resolves to that
 * lookup App supply the access-backfill users.
 *
 * Each agent with a GH_APP_ID also gets one agent target per org its account's
 * installer can reach (keyed as GLC-1.5 keys it). No installer, no agent
 * targets.
 *
 * Keys are deduplicated, and a scope or agent whose discovery fails is logged
 * and skipped without affecting the rest. The stored-App wiring (key-bearing)
 * is createStoredAppRefreshDiscovery in github-installation-wiring.ts.
 */

import type { Clock } from "./clock.ts";
import type { AccessProbe, BackfillUser } from "./github-access-backfill.ts";
import {
  type AgentInstallationClient,
  crawlAgentInstallation,
  DEPLOYMENT_WIDE_ACCOUNT_KEY,
} from "./github-agent-installation-crawler.ts";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import type { GithubLookupClient } from "./github-lookup-client.ts";
import type { SnapshotKey } from "./github-repo-cache.ts";
import {
  type CrawlStore,
  crawlRepos,
  lookupRepoPageSource,
  type PageSource,
  type RepoPage,
} from "./github-repo-crawler.ts";
import {
  type RefreshDiscovery,
  type RefreshTarget,
  snapshotKeyString,
} from "./github-repo-refresher.ts";
import type { InstallationAgentRecord } from "./installation-ports.ts";

/** The lookup-client surface discovery and its targets use. */
export type LookupAppClient = AccessProbe &
  Pick<
    GithubLookupClient,
    "listInstallations" | "listInstallationRepositoriesPage"
  >;

export interface ResolvedLookupApp {
  /** The scope that owns the App row (null: deployment-wide). */
  accountId: string | null;
  appId: string;
  client: LookupAppClient;
}

export interface DiscoveryPorts {
  /** Accounts with GitHub Apps of their own (the deployment-wide scope is implied). */
  listAppScopes(): Promise<(string | null)[]>;
  listAgents(): Promise<InstallationAgentRecord[]>;
  /** The lookup App this scope resolves to; null when none is usable. */
  lookupApp(scope: string | null): Promise<ResolvedLookupApp | null>;
  /** Orgs the scope's installer App can reach; null when there is no installer with an enterprise slug. */
  installerOrgs(scope: string | null): Promise<string[] | null>;
  installer: AgentInstallationClient;
  store: CrawlStore;
  clock: Clock;
  log?: (line: string) => void;
}

/**
 * A lookup page source where not_found (the lookup App is not installed on
 * the org) is an empty, last page, so the org records as an empty complete
 * snapshot instead of failing with backoff forever.
 */
export function notFoundAsEmpty(source: PageSource): PageSource {
  return {
    async fetchPage(page: number): Promise<RepoPage> {
      try {
        return await source.fetchPage(page);
      } catch (err) {
        if (err instanceof GithubEnterpriseError && err.kind === "not_found") {
          return { repos: [], totalCount: 0, hasNext: false };
        }
        throw err;
      }
    },
  };
}

const scopeKeyOf = (accountId: string | null | undefined): string =>
  accountId || DEPLOYMENT_WIDE_ACCOUNT_KEY;

/** Repo names (without org) in `org` from an agent's owner/repo list. */
function reposInOrg(repos: readonly string[], org: string): string[] {
  const prefix = `${org.toLowerCase()}/`;
  return repos
    .filter((r) => r.toLowerCase().startsWith(prefix))
    .map((r) => r.slice(prefix.length));
}

export function createRefreshDiscovery(
  ports: DiscoveryPorts,
): RefreshDiscovery {
  const log = ports.log ?? ((line: string) => console.error(line));
  return {
    async listTargets(): Promise<RefreshTarget[]> {
      const { store, clock, installer } = ports;
      const lookupMemo = new Map<
        string | null,
        Promise<ResolvedLookupApp | null>
      >();
      const orgsMemo = new Map<string | null, Promise<string[] | null>>();
      const lookupFor = (scope: string | null) => {
        let p = lookupMemo.get(scope);
        if (!p) {
          p = ports.lookupApp(scope);
          lookupMemo.set(scope, p);
        }
        return p;
      };
      const installerOrgsFor = (scope: string | null) => {
        let p = orgsMemo.get(scope);
        if (!p) {
          p = ports.installerOrgs(scope);
          orgsMemo.set(scope, p);
        }
        return p;
      };

      const scopes = [...new Set([null, ...(await ports.listAppScopes())])];
      const agents = await ports.listAgents();
      const targets = new Map<string, RefreshTarget>();
      const add = (t: RefreshTarget) => {
        const k = snapshotKeyString(t.key);
        if (!targets.has(k)) targets.set(k, t);
      };

      // Access users per lookup scope key: agents with an App and a user.
      const usersByScope = new Map<string, InstallationAgentRecord[]>();
      for (const a of agents) {
        if (a.appId === undefined || !a.githubUsername?.trim()) continue;
        try {
          const lookup = await lookupFor(a.accountId ?? null);
          if (!lookup) continue;
          const k = scopeKeyOf(lookup.accountId);
          usersByScope.set(k, [...(usersByScope.get(k) ?? []), a]);
        } catch {
          // The scope loop below logs the same failure once.
        }
      }

      for (const scope of scopes) {
        try {
          const lookup = await lookupFor(scope);
          if (!lookup) continue;
          const orgs =
            (await installerOrgsFor(scope)) ??
            (await lookup.client.listInstallations()).map((i) => i.login);
          const accountId = scopeKeyOf(lookup.accountId);
          const bound = usersByScope.get(accountId) ?? [];
          for (const org of orgs) {
            const key: SnapshotKey = {
              accountId,
              appKind: "lookup",
              appRef: lookup.appId,
              org,
            };
            const users: BackfillUser[] = bound.map((a) => ({
              username: (a.githubUsername as string).trim(),
              configuredRepos: reposInOrg(a.repos, org),
            }));
            const source = notFoundAsEmpty(
              lookupRepoPageSource(lookup.client, org),
            );
            add({
              key,
              crawl: (ctx) =>
                crawlRepos({
                  key,
                  source,
                  store,
                  clock,
                  shouldStop: ctx.shouldStop,
                }),
              ...(users.length > 0
                ? { access: { probe: lookup.client, users } }
                : {}),
            });
          }
        } catch (err) {
          log(
            `[github-repo-refresher] discovery for scope ${scopeKeyOf(scope)} failed: ${messageOf(err)}`,
          );
        }
      }

      for (const a of agents) {
        if (a.appId === undefined) continue;
        try {
          const orgs = await installerOrgsFor(a.accountId ?? null);
          if (!orgs) continue;
          for (const org of orgs) {
            add({
              key: {
                accountId: scopeKeyOf(a.accountId),
                appKind: "agent",
                appRef: String(a.appId),
                org,
              },
              crawl: (ctx) =>
                crawlAgentInstallation({
                  agent: a,
                  org,
                  client: installer,
                  store,
                  clock,
                  shouldStop: ctx.shouldStop,
                }),
            });
          }
        } catch (err) {
          log(
            `[github-repo-refresher] discovery for agent ${a.id} failed: ${messageOf(err)}`,
          );
        }
      }
      return [...targets.values()];
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
