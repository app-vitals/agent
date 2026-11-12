/**
 * admin/src/installation-repos-service.ts
 * Read-only listing of the repos on an agent's own GitHub App installation
 * (IRM-1.2), with the bound user's push hint. Changes go through the Sync flow
 * (github-sync.ts, IRM-3.1). Uses the installer App through the installation port.
 */

import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import {
  AppNotInstalledError,
  MISSING_APP_ID_REASON,
  type InstallationAgentsPort,
  type AppInstallationPort,
} from "./installation-ports.ts";
import type {
  OrgAccessResult,
  UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

/** Installation port plus discovery of the orgs the agent App is installed on. */
export interface InstallationReposPort extends AppInstallationPort {
  listInstalled(appId: number): Promise<{ org: string; repos: string[] }[]>;
}

export interface InstallationRepoView {
  fullName: string;
  /** Present only when the bound user's access to this repo is known. */
  userCanPush?: boolean;
}

export interface InstallationOrgView {
  org: string;
  repos: InstallationRepoView[];
}

export type InstallationListResult =
  | { status: "agent_not_found" }
  | { status: "no_app_id"; reason: string }
  | { status: "ok"; appId: number; orgs: InstallationOrgView[] };

export interface InstallationReposDeps {
  agents: Pick<InstallationAgentsPort, "get">;
  access: GithubAccessPreviewFn;
  installation: InstallationReposPort;
}

const orgKey = (org: string): string => org.toLowerCase();

/**
 * The user-can-push hint for one org: true/false per repo only when the bound
 * user is verified and this org's lookup result is complete ("ok", nothing
 * unresolved). A repo the lookup did not list is unknown, so it gets no hint
 * (never false).
 */
export function userPushHints(
  access: UserRepoAccessResult | undefined,
  org: string,
  repos: readonly string[],
): InstallationRepoView[] {
  const orgResult: OrgAccessResult | undefined = access?.orgs.find(
    (o) => orgKey(o.org) === orgKey(org),
  );
  const complete =
    access !== undefined &&
    access.outcome === "ok" &&
    access.userVerified &&
    orgResult !== undefined &&
    orgResult.status === "ok" &&
    orgResult.unresolved === 0;
  const pushByName = new Map<string, boolean>();
  if (complete) {
    for (const r of orgResult.repos) {
      pushByName.set(r.fullName.toLowerCase(), r.canPush);
    }
  }
  return repos.map((fullName) => {
    const hint = pushByName.get(fullName.toLowerCase());
    return hint === undefined ? { fullName } : { fullName, userCanPush: hint };
  });
}

export class InstallationReposService {
  constructor(private readonly deps: InstallationReposDeps) {}

  async list(agentId: string): Promise<InstallationListResult> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) return { status: "agent_not_found" };
    if (agent.appId === undefined) {
      return { status: "no_app_id", reason: MISSING_APP_ID_REASON };
    }
    const installed = await this.deps.installation.listInstalled(agent.appId);
    const username = agent.githubUsername?.trim();
    let access: UserRepoAccessResult | undefined;
    if (username) {
      try {
        const preview = await this.deps.access(username);
        if (preview.status === "ok") access = preview.access;
      } catch {
        // The hint is advisory: a failed lookup omits it.
      }
    }
    return {
      status: "ok",
      appId: agent.appId,
      orgs: installed.map(({ org, repos }) => ({
        org,
        repos: userPushHints(access, org, repos),
      })),
    };
  }
}

/** The slice of the installer client the installation-repos port needs. */
export interface InstalledOrgsClient {
  listInstallableOrganizations(): Promise<{ login: string }[]>;
}

/**
 * Port over the installation port plus org discovery: the orgs the
 * installer can reach that carry an installation of the agent's App.
 */
export function createInstallationReposPort(
  base: AppInstallationPort,
  client: InstalledOrgsClient,
): InstallationReposPort {
  return {
    ...base,
    async listInstalled(appId) {
      const out: { org: string; repos: string[] }[] = [];
      for (const { login } of await client.listInstallableOrganizations()) {
        try {
          const repos = await base.listRepos(appId, [login]);
          out.push({ org: login, repos: repos[login] ?? [] });
        } catch (err) {
          if (err instanceof AppNotInstalledError) continue;
          throw err;
        }
      }
      return out;
    },
  };
}
