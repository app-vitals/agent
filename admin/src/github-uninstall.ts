/**
 * admin/src/github-uninstall.ts
 * Pure helpers for uninstalling the agent App from an org (GIS-1.5): match the
 * agent App's installation among an org's installations (same identity rules as
 * the install route: client id, then slug, then app id) and plan which of the
 * agent's repos the uninstall removes. The cleanup itself (agent repos, open
 * work, audit) reuses Sync's removal handling from the route.
 */

import type { AppInstallation } from "./github-enterprise-client.ts";
import { MAX_UNCONFIRMED_REMOVALS } from "./installation-ports.ts";
import { repoOrg } from "./repo-access-rules.ts";

/** `planHash` of the audit row an org uninstall writes. */
export const GITHUB_UNINSTALL_AUDIT_PLAN_HASH = "uninstall:org";

export function uninstallBlockReason(repo: string): string {
  return `repo ${repo} was removed from the agent because the agent App was uninstalled from its org`;
}

export interface AgentAppIdentity {
  clientId?: string | null;
  slug?: string | null;
  appId?: number | null;
}

/** The installation of the agent's App, or undefined when it is not installed. */
export function findAgentInstallation(
  installs: readonly AppInstallation[],
  identity: AgentAppIdentity,
): AppInstallation | undefined {
  const { clientId, slug, appId } = identity;
  if (clientId) {
    const hit = installs.find((i) => i.clientId === clientId);
    if (hit) return hit;
  }
  if (slug) {
    const hit = installs.find(
      (i) => i.appSlug.toLowerCase() === slug.toLowerCase(),
    );
    if (hit) return hit;
  }
  if (appId) return installs.find((i) => i.appId === appId);
  return undefined;
}

export interface OrgUninstallPlan {
  org: string;
  /** The agent's repos in the org (removed from the agent), sorted. */
  repos: string[];
  /** True when more repos than MAX_UNCONFIRMED_REMOVALS would be removed. */
  needsConfirm: boolean;
}

export function planOrgUninstall(input: {
  org: string;
  agentRepos: readonly string[];
}): OrgUninstallPlan {
  const org = input.org.toLowerCase();
  const repos = [
    ...new Set(
      input.agentRepos.filter((r) => repoOrg(r).toLowerCase() === org),
    ),
  ].sort();
  return {
    org: input.org,
    repos,
    needsConfirm: repos.length > MAX_UNCONFIRMED_REMOVALS,
  };
}
