/**
 * admin/src/github-reconcile-wiring.ts
 * Composition of the GitHub reconcile service for admin boot (GHE-3.9).
 * Builds ReconcileApplyService from the stored enterprise Apps and an
 * optional host-supplied OpenWorkPort. The agent App id comes from each agent's
 * own stored GH_APP_ID; without an open-work port nothing is listed or blocked.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { GithubEnterpriseClient } from "./github-enterprise-client.ts";
import {
  createInstallationPort,
  type InstallationRepoClient,
  PrismaReconcileAgents,
  PrismaReconcileAudit,
  ReconcileApplyService,
  type ReconcileInstallationPort,
} from "./reconcile-apply-service.ts";
import type { OpenWorkPort } from "./reconcile-open-work.ts";

export interface GithubReconcileWiringDeps {
  prisma: PrismaClient;
  appService: Pick<GitHubEnterpriseAppService, "get" | "getPrivateKey">;
  access: GithubAccessPreviewFn;
  /** Reads each agent's stored GH_APP_ID (its own GitHub App). */
  agentEnv: Pick<AgentEnvService, "getConfigBundle">;
  openWork?: OpenWorkPort;
  /** Test seam: replaces the installer-App-backed installation port. */
  installation?: ReconcileInstallationPort;
  /** Test seams; default to the real GitHub API. */
  fetchFn?: typeof fetch;
  apiBase?: string;
  now?: () => Date;
}

/** Builds the installer client per call so key rotations are picked up. */
function lazyInstallerClient(
  deps: Pick<
    GithubReconcileWiringDeps,
    "appService" | "fetchFn" | "apiBase" | "now"
  >,
): InstallationRepoClient {
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

/**
 * The `githubReconcile` dep for createAdminApp. The agent App id is resolved
 * per agent from its stored GH_APP_ID, so this is always wired.
 */
export function createGithubReconcile(
  deps: GithubReconcileWiringDeps,
): ReconcileApplyService {
  return new ReconcileApplyService({
    agents: new PrismaReconcileAgents(deps.prisma, deps.agentEnv),
    access: deps.access,
    installation:
      deps.installation ?? createInstallationPort(lazyInstallerClient(deps)),
    audit: new PrismaReconcileAudit(deps.prisma),
    ...(deps.openWork ? { openWork: deps.openWork } : {}),
  });
}
