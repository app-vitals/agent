/**
 * admin/src/github-reconcile-wiring.ts
 * Composition of the GitHub reconcile service for admin boot (GHE-3.9).
 * Builds ReconcileApplyService from the stored enterprise Apps and an
 * optional host-supplied OpenWorkPort. Without an agent App id the reconcile
 * is not wired (routes report `skipped`); without an open-work port nothing is
 * listed or blocked.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
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
  /** Numeric id of the agent App whose installations are reconciled. */
  agentAppId: number | undefined;
  openWork?: OpenWorkPort;
  /** Test seam: replaces the installer-App-backed installation port. */
  installation?: ReconcileInstallationPort;
  /** Test seams; default to the real GitHub API. */
  fetchFn?: typeof fetch;
  apiBase?: string;
  now?: () => Date;
}

/** Parses SHIPWRIGHT_GITHUB_AGENT_APP_ID; unset or non-numeric -> undefined. */
export function parseAgentAppId(raw: string | undefined): number | undefined {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
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

/** The `githubReconcile` dep for createAdminApp, or undefined when unwired. */
export function createGithubReconcile(
  deps: GithubReconcileWiringDeps,
): ReconcileApplyService | undefined {
  if (deps.agentAppId === undefined) return undefined;
  return new ReconcileApplyService({
    agents: new PrismaReconcileAgents(deps.prisma),
    access: deps.access,
    installation:
      deps.installation ??
      createInstallationPort(lazyInstallerClient(deps), deps.agentAppId),
    audit: new PrismaReconcileAudit(deps.prisma),
    ...(deps.openWork ? { openWork: deps.openWork } : {}),
  });
}
