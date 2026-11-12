/**
 * admin/src/installation-ports.ts
 * Ports and Prisma/GitHub-backed adapters shared by the installation repos
 * service (IRM-1.2) and GitHub Sync (IRM-3.1): the agent record
 * with its own GH_APP_ID, installation list/add/remove scoped to that App, and
 * the audit table (GitHubReconcileAudit) every change is recorded in.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentEnvService } from "./agent-envs.ts";

/** Parses a stored GH_APP_ID; unset or non-numeric -> undefined. */
function parseAppId(raw: string | undefined): number | undefined {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** More removals than this need confirmRemovals. */
export const MAX_UNCONFIRMED_REMOVALS = 10;

export interface InstallationAgentRecord {
  id: string;
  repos: string[];
  githubUsername: string | null;
  /** The agent's own GitHub App id (its stored GH_APP_ID); undefined when unset or not numeric. */
  appId?: number;
}

export interface InstallationAgentsPort {
  get(agentId: string): Promise<InstallationAgentRecord | null>;
  setRepos(agentId: string, repos: string[]): Promise<void>;
}

/**
 * Repo access on an agent App's installations, per org login. Each agent has
 * its own App, so every call names the App (`appId`) whose installation is used.
 */
export interface AppInstallationPort {
  /** Repos the agent App covers in each org; only the named orgs are needed. */
  listRepos(
    appId: number,
    orgs: readonly string[],
  ): Promise<Record<string, string[]>>;
  /** Grant the installation access to repos (owner/repo, all in `org`). */
  addRepos(appId: number, org: string, repos: readonly string[]): Promise<void>;
  removeRepos(
    appId: number,
    org: string,
    repos: readonly string[],
  ): Promise<void>;
}

/** Repos changed by one audited change, on the installation and in the agent's config. */
export interface InstallationAuditDiff {
  installationAdds: string[];
  installationRemoves: string[];
  configAdds: string[];
  configRemoves: string[];
}

export interface InstallationAuditEntry {
  agentId: string;
  caller: string;
  /** Stored in the audit table's planHash column: a label for the kind of change. */
  planHash: string;
  diff: InstallationAuditDiff;
  result: InstallationAuditResult;
}

export interface InstallationAuditResult {
  status: "applied" | "failed";
  error?: string;
}

export interface InstallationAuditPort {
  write(entry: InstallationAuditEntry): Promise<string>;
}

/** Skip reason when the agent has no usable GH_APP_ID in its stored env. */
export const MISSING_APP_ID_REASON =
  "agent has no GH_APP_ID in its stored env (its own GitHub App is not set up)";

/** Prisma-backed audit store (GitHubReconcileAudit). */
export class PrismaInstallationAudit implements InstallationAuditPort {
  constructor(private readonly prisma: PrismaClient) {}

  async write(entry: InstallationAuditEntry): Promise<string> {
    const row = await this.prisma.gitHubReconcileAudit.create({
      data: {
        agentId: entry.agentId,
        caller: entry.caller,
        planHash: entry.planHash,
        diff: entry.diff as unknown as object,
        result: entry.result as unknown as object,
      },
    });
    return row.id;
  }
}

/** Prisma-backed agent reads/writes. */
export class PrismaInstallationAgents implements InstallationAgentsPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Pick<AgentEnvService, "getConfigBundle">,
  ) {}

  async get(agentId: string): Promise<InstallationAgentRecord | null> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, repos: true, githubUsername: true },
    });
    if (!agent) return null;
    const raw = (await this.env.getConfigBundle(agentId))?.env.GH_APP_ID;
    const appId = parseAppId(raw);
    return appId === undefined ? agent : { ...agent, appId };
  }

  async setRepos(agentId: string, repos: string[]): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { repos },
    });
  }
}

/** The slice of GithubEnterpriseClient the installation port needs. */
export interface InstallationRepoClient {
  listOrgInstallations(org: string): Promise<{ id: number; appId: number }[]>;
  listInstallationRepositories(
    org: string,
    installationId: number,
  ): Promise<{ fullName: string }[]>;
  addRepositories(
    org: string,
    installationId: number,
    names: readonly string[],
  ): Promise<unknown>;
  removeRepositories(
    org: string,
    installationId: number,
    names: readonly string[],
  ): Promise<unknown>;
}

/** The agent App has no installation on the org (distinct from a GitHub failure). */
export class AppNotInstalledError extends Error {
  constructor(
    readonly appId: number,
    readonly org: string,
  ) {
    super(
      `agent App ${appId} (the agent's GH_APP_ID) is not installed on org ${org}`,
    );
    this.name = "AppNotInstalledError";
  }
}

const baseName = (fullName: string): string => fullName.split("/")[1] ?? "";

/**
 * AppInstallationPort over GithubEnterpriseClient. Each call
 * is scoped to the named agent App's installation on the org.
 */
export function createInstallationPort(
  client: InstallationRepoClient,
): AppInstallationPort {
  const installationId = async (
    appId: number,
    org: string,
  ): Promise<number> => {
    const found = (await client.listOrgInstallations(org)).find(
      (i) => i.appId === appId,
    );
    if (!found) {
      throw new AppNotInstalledError(appId, org);
    }
    return found.id;
  };
  return {
    async listRepos(appId, orgs) {
      const out: Record<string, string[]> = {};
      for (const org of orgs) {
        const repos = await client.listInstallationRepositories(
          org,
          await installationId(appId, org),
        );
        out[org] = repos.map((r) => r.fullName);
      }
      return out;
    },
    async addRepos(appId, org, repos) {
      await client.addRepositories(
        org,
        await installationId(appId, org),
        repos.map(baseName),
      );
    },
    async removeRepos(appId, org, repos) {
      await client.removeRepositories(
        org,
        await installationId(appId, org),
        repos.map(baseName),
      );
    },
  };
}
