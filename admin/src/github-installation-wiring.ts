/**
 * admin/src/github-installation-wiring.ts
 * Composition of the installation repos list and GitHub Sync services for
 * admin boot, from the stored installer App and an optional host-supplied
 * OpenWorkPort, plus the GitHub cache refresher's target discovery over the
 * stored Apps (GLC-1.4). The agent App id comes from each agent's own stored
 * GH_APP_ID; without an open-work port nothing is listed or blocked.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { Clock } from "./clock.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { GithubEnterpriseClient } from "./github-enterprise-client.ts";
import { DEPLOYMENT_WIDE_ACCOUNT_KEY } from "./github-agent-installation-crawler.ts";
import { GithubLookupClient } from "./github-lookup-client.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import type { CrawlStore } from "./github-repo-crawler.ts";
import { createRefreshDiscovery } from "./github-repo-refresh-discovery.ts";
import type { RefreshDiscovery } from "./github-repo-refresher.ts";
import { canPushForRole } from "./user-repo-access-resolver.ts";
import { type GithubSyncDeps, GithubSyncService } from "./github-sync.ts";
import {
  createInstallationPort,
  type InstallationAgentRecord,
  type InstallationRepoClient,
  PrismaInstallationAgents,
  PrismaInstallationAudit,
} from "./installation-ports.ts";
import {
  createInstallationReposPort,
  type InstallationReposPort,
  InstallationReposService,
  type InstalledOrgsClient,
} from "./installation-repos-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";

export interface GithubInstallationWiringDeps {
  prisma: PrismaClient;
  appService: Pick<GitHubEnterpriseAppService, "get" | "getPrivateKey">;
  access: GithubAccessPreviewFn;
  /** Reads each agent's stored GH_APP_ID (its own GitHub App). */
  agentEnv: Pick<AgentEnvService, "getConfigBundle">;
  openWork?: OpenWorkPort;
  /** Test seams; default to the real GitHub API. */
  fetchFn?: typeof fetch;
  apiBase?: string;
  now?: () => Date;
}

/** Builds the installer client per call so key rotations are picked up. */
export function lazyInstallerClient(
  deps: Pick<
    GithubInstallationWiringDeps,
    "appService" | "fetchFn" | "apiBase" | "now"
  >,
): InstallationRepoClient &
  InstalledOrgsClient &
  Required<Pick<InstallationRepoClient, "listInstallationRepositoriesPage">> {
  const client = async (
    accountId?: string | null,
  ): Promise<GithubEnterpriseClient> => {
    const [installer, privateKey] = await Promise.all([
      deps.appService.get("installer", accountId),
      deps.appService.getPrivateKey("installer", accountId),
    ]);
    if (!installer?.enterpriseSlug || !privateKey) {
      throw new Error("installer App is not configured");
    }
    return new GithubEnterpriseClient({
      appId: installer.appId,
      enterprise: installer.enterpriseSlug,
      privateKey,
      apiBase: deps.apiBase,
      fetchFn: deps.fetchFn,
      now: deps.now,
    });
  };
  return {
    listInstallableOrganizations: async (accountId) =>
      (await client(accountId)).listInstallableOrganizations(),
    listOrgInstallations: async (org, accountId) =>
      (await client(accountId)).listOrgInstallations(org),
    listInstallationRepositories: async (org, id, accountId) =>
      (await client(accountId)).listInstallationRepositories(org, id),
    listInstallationRepositoriesPage: async (org, id, page, accountId) =>
      (await client(accountId)).listInstallationRepositoriesPage(org, id, page),
    addRepositories: async (org, id, names, accountId) =>
      (await client(accountId)).addRepositories(org, id, names),
    removeRepositories: async (org, id, names, accountId) =>
      (await client(accountId)).removeRepositories(org, id, names),
  };
}

export interface InstallationReposWiringDeps
  extends GithubInstallationWiringDeps {
  /** Test seam: replaces the installer-App-backed port. */
  installationRepos?: InstallationReposPort;
  /** Test seam: replaces the lookup-App-backed sync cache source and re-check. */
  syncOverrides?: Pick<GithubSyncDeps, "lookupRepos" | "verifyPush">;
}

/**
 * The `githubInstallationRepos` dep for createAdminApp (IRM-1.2): direct
 * list the repos on the agent App's installation.
 */
export function createGithubInstallationRepos(
  deps: InstallationReposWiringDeps,
): InstallationReposService {
  const client = lazyInstallerClient(deps);
  return new InstallationReposService({
    agents: new PrismaInstallationAgents(deps.prisma, deps.agentEnv),
    access: deps.access,
    installation:
      deps.installationRepos ??
      createInstallationReposPort(createInstallationPort(client), client),
    cache: new GitHubRepoCacheService(deps.prisma),
  });
}

/**
 * The `githubSync` dep for createAdminApp (IRM-3.1): installation adds and
 * removes plus agent-repo removals for the repos the bound user can or can no
 * longer push to, audited once and blocking open work through the optional
 * host OpenWorkPort.
 */
export function createGithubSync(
  deps: InstallationReposWiringDeps,
): GithubSyncService {
  const client = lazyInstallerClient(deps);
  const cache = new GitHubRepoCacheService(deps.prisma);
  const lookupClients = new Map<string, GithubLookupClient>();
  // The lookup client per App (and key version), reused with its installation tokens.
  const lookupClient = async (accountId?: string | null) => {
    const meta = await deps.appService.get("lookup", accountId);
    if (!meta) return null;
    const privateKey = await deps.appService.getPrivateKey("lookup", accountId);
    if (!privateKey) return null;
    const cacheKey = `${meta.accountId ?? ""}|${meta.appId}|${meta.updatedAt.getTime()}`;
    let c = lookupClients.get(cacheKey);
    if (!c) {
      c = new GithubLookupClient({
        appId: meta.appId,
        privateKey,
        apiBase: deps.apiBase,
        fetchFn: deps.fetchFn,
        now: deps.now,
      });
      lookupClients.set(cacheKey, c);
    }
    return { client: c, appId: meta.appId };
  };
  return new GithubSyncService({
    agents: new PrismaInstallationAgents(deps.prisma, deps.agentEnv),
    access: deps.access,
    cache,
    ...(deps.now ? { now: deps.now } : {}),
    lookupRepos: async (accountId) => {
      const lookup = await lookupClient(accountId);
      if (!lookup) return [];
      // The crawler files a deployment-wide App's snapshots under
      // DEPLOYMENT_WIDE_ACCOUNT_KEY, so a null-account agent reads that key and
      // an account agent reads its own account plus that key.
      // Note: a real account literally named "deployment" would collide with
      // this fallback key; that is known and deliberately not fixed here.
      const snapshots = await cache.listLookupOrgSnapshots(
        accountId
          ? [accountId, DEPLOYMENT_WIDE_ACCOUNT_KEY]
          : [DEPLOYMENT_WIDE_ACCOUNT_KEY],
        lookup.appId,
      );
      return snapshots.map((s) => ({
        org: s.org,
        completedAt: s.completedAt,
        repos: s.repos.map((r) => r.fullName),
      }));
    },
    // One permission call per removal candidate; undefined on any failure.
    verifyPush: async (username, repo, accountId) => {
      try {
        const lookup = await lookupClient(accountId);
        if (!lookup) return undefined;
        const [owner, name] = repo.split("/");
        if (!owner || !name) return undefined;
        const { role } =
          await lookup.client.getCollaboratorPermissionWithRateLimit(
            owner,
            name,
            username,
          );
        return canPushForRole(role);
      } catch {
        return undefined;
      }
    },
    ...deps.syncOverrides,
    installation:
      deps.installationRepos ??
      createInstallationReposPort(createInstallationPort(client), client),
    audit: new PrismaInstallationAudit(deps.prisma),
    ...(deps.openWork ? { openWork: deps.openWork } : {}),
  });
}

export interface StoredAppDiscoveryDeps {
  prisma: PrismaClient;
  appService: Pick<
    GitHubEnterpriseAppService,
    "get" | "getPrivateKey" | "listAccountIds"
  >;
  /** Reads each agent's stored GH_APP_ID (its own GitHub App). */
  agentEnv: Pick<AgentEnvService, "getConfigBundle">;
  store: CrawlStore;
  clock: Clock;
  /** Test seams; default to the real GitHub API. */
  fetchFn?: typeof fetch;
  apiBase?: string;
}

/**
 * The refresher's target discovery (GLC-1.4) over the stored Apps, the
 * agents table and real GitHub clients. Lives here, beside the other
 * key-bearing installation wiring, so the private key stays in the
 * allowlisted modules.
 */
export function createStoredAppRefreshDiscovery(
  deps: StoredAppDiscoveryDeps,
): RefreshDiscovery {
  const { prisma, appService, fetchFn, apiBase, clock } = deps;
  const now = () => clock.now();
  const installer = lazyInstallerClient({ appService, fetchFn, apiBase, now });
  const agentsPort = new PrismaInstallationAgents(prisma, deps.agentEnv);
  // Reuse a client (and its cached installation tokens) until the App changes.
  const lookupClients = new Map<string, GithubLookupClient>();
  return createRefreshDiscovery({
    listAppScopes: () => appService.listAccountIds(),
    async listAgents() {
      const rows = await prisma.agent.findMany({ select: { id: true } });
      const out: InstallationAgentRecord[] = [];
      for (const { id } of rows) {
        const rec = await agentsPort.get(id);
        if (rec) out.push(rec);
      }
      return out;
    },
    async lookupApp(scope) {
      const meta = await appService.get("lookup", scope);
      if (!meta) return null;
      const privateKey = await appService.getPrivateKey("lookup", scope);
      if (!privateKey) return null;
      const cacheKey = `${meta.accountId ?? ""}|${meta.appId}|${meta.updatedAt.getTime()}`;
      let client = lookupClients.get(cacheKey);
      if (!client) {
        client = new GithubLookupClient({
          appId: meta.appId,
          privateKey,
          apiBase,
          fetchFn,
          now,
        });
        lookupClients.set(cacheKey, client);
      }
      return { accountId: meta.accountId ?? null, appId: meta.appId, client };
    },
    async installerOrgs(scope) {
      const meta = await appService.get("installer", scope);
      if (!meta?.enterpriseSlug) return null;
      return (await installer.listInstallableOrganizations(scope)).map(
        (o) => o.login,
      );
    },
    installer,
    store: deps.store,
    clock,
  });
}
