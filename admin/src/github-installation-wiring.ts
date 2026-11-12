/**
 * admin/src/github-installation-wiring.ts
 * Composition of the installation repos list and GitHub Sync services for
 * admin boot, from the stored installer App and an optional host-supplied
 * OpenWorkPort. The agent App id comes from each agent's own stored
 * GH_APP_ID; without an open-work port nothing is listed or blocked.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { GithubEnterpriseClient } from "./github-enterprise-client.ts";
import {
  createInstallationPort,
  type InstallationRepoClient,
  PrismaInstallationAgents,
  PrismaInstallationAudit,
} from "./installation-ports.ts";
import {
  createInstallationReposPort,
  type InstalledOrgsClient,
  InstallationReposService,
  type InstallationReposPort,
} from "./installation-repos-service.ts";
import { GithubSyncService } from "./github-sync.ts";
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
function lazyInstallerClient(
  deps: Pick<
    GithubInstallationWiringDeps,
    "appService" | "fetchFn" | "apiBase" | "now"
  >,
): InstallationRepoClient & InstalledOrgsClient {
  const client = async (): Promise<GithubEnterpriseClient> => {
    const [installer, privateKey] = await Promise.all([
      deps.appService.get("installer"),
      deps.appService.getPrivateKey("installer"),
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
    listInstallableOrganizations: async () =>
      (await client()).listInstallableOrganizations(),
    listOrgInstallations: async (org) =>
      (await client()).listOrgInstallations(org),
    listInstallationRepositories: async (org, id) =>
      (await client()).listInstallationRepositories(org, id),
    addRepositories: async (org, id, names) =>
      (await client()).addRepositories(org, id, names),
    removeRepositories: async (org, id, names) =>
      (await client()).removeRepositories(org, id, names),
  };
}

export interface InstallationReposWiringDeps
  extends GithubInstallationWiringDeps {
  /** Test seam: replaces the installer-App-backed port. */
  installationRepos?: InstallationReposPort;
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
  return new GithubSyncService({
    agents: new PrismaInstallationAgents(deps.prisma, deps.agentEnv),
    access: deps.access,
    installation:
      deps.installationRepos ??
      createInstallationReposPort(createInstallationPort(client), client),
    audit: new PrismaInstallationAudit(deps.prisma),
    ...(deps.openWork ? { openWork: deps.openWork } : {}),
  });
}
