/**
 * admin/src/installation-repos-service.ts
 * Direct management of the repos on an agent's own GitHub App installation
 * (IRM-1.2): list, add and remove without a reconcile plan step. Uses the
 * installer App through the reconcile installation port, and writes every
 * add/remove to the existing GitHubReconcileAudit table (no schema change):
 * `planHash` is "direct:add" / "direct:remove" and the changed repos land in
 * the diff's installationAdds / installationRemoves.
 */

import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import {
  AppNotInstalledError,
  MISSING_APP_ID_REASON,
  type ReconcileAgentsPort,
  type ReconcileAuditPort,
  type ReconcileInstallationPort,
} from "./reconcile-apply-service.ts";
import { repoOrg } from "./reconcile-planner.ts";
import type {
  OrgAccessResult,
  UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

/** Installation port plus discovery of the orgs the agent App is installed on. */
export interface InstallationReposPort extends ReconcileInstallationPort {
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

export type InstallationChangeResult =
  | { status: "agent_not_found" }
  | { status: "no_app_id"; reason: string }
  | { status: "not_installed"; org: string; reason: string }
  | { status: "applied"; auditId: string; repos: string[] }
  | { status: "failed"; auditId: string; error: string };

export interface InstallationReposDeps {
  agents: Pick<ReconcileAgentsPort, "get">;
  access: GithubAccessPreviewFn;
  installation: InstallationReposPort;
  audit: ReconcileAuditPort;
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

function groupByOrg(repos: readonly string[]): Map<string, string[]> {
  const byOrg = new Map<string, string[]>();
  for (const r of repos) {
    const org = repoOrg(r);
    byOrg.set(org, [...(byOrg.get(org) ?? []), r]);
  }
  return byOrg;
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

  add(
    agentId: string,
    caller: string,
    repos: readonly string[],
  ): Promise<InstallationChangeResult> {
    return this.change("add", agentId, caller, repos);
  }

  remove(
    agentId: string,
    caller: string,
    repos: readonly string[],
  ): Promise<InstallationChangeResult> {
    return this.change("remove", agentId, caller, repos);
  }

  private async change(
    kind: "add" | "remove",
    agentId: string,
    caller: string,
    input: readonly string[],
  ): Promise<InstallationChangeResult> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) return { status: "agent_not_found" };
    if (agent.appId === undefined) {
      return { status: "no_app_id", reason: MISSING_APP_ID_REASON };
    }
    const appId = agent.appId;
    const repos = [...new Set(input)];
    const byOrg = groupByOrg(repos);
    const { installation } = this.deps;
    // Nothing is written (or audited) when an org has no installation.
    try {
      await installation.listRepos(appId, [...byOrg.keys()]);
    } catch (err) {
      if (err instanceof AppNotInstalledError) {
        return { status: "not_installed", org: err.org, reason: err.message };
      }
      throw err;
    }
    const changed: string[] = [];
    let error: string | undefined;
    try {
      for (const [org, orgRepos] of byOrg) {
        if (kind === "add") await installation.addRepos(appId, org, orgRepos);
        else await installation.removeRepos(appId, org, orgRepos);
        changed.push(...orgRepos);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Record what actually changed; on failure, only the repos that landed.
    const done = error === undefined ? repos : changed;
    const auditId = await this.deps.audit.write({
      agentId,
      caller,
      planHash: `direct:${kind}`,
      diff: {
        installationAdds: kind === "add" ? done : [],
        installationRemoves: kind === "remove" ? done : [],
        configAdds: [],
        configRemoves: [],
      },
      result:
        error === undefined
          ? { status: "applied" }
          : { status: "failed", error },
    });
    return error === undefined
      ? { status: "applied", auditId, repos }
      : { status: "failed", auditId, error };
  }
}

/** The slice of the installer client the installation-repos port needs. */
export interface InstalledOrgsClient {
  listInstallableOrganizations(): Promise<{ login: string }[]>;
}

/**
 * Port over the reconcile installation port plus org discovery: the orgs the
 * installer can reach that carry an installation of the agent's App.
 */
export function createInstallationReposPort(
  base: ReconcileInstallationPort,
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
