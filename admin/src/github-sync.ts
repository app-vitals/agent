/**
 * admin/src/github-sync.ts
 * GitHub Sync (IRM-3.1): one preview and one apply, per agent with a bound
 * GitHub username, that bring the agent App's installation and the agent's
 * own repos in line with what the bound user can push to.
 *
 * Preview computes three lists plus the open work the removals would block:
 *   1. APP adds: repos the user can push to, in orgs the agent App is
 *      installed on, that are not on the installation (no cap);
 *   2. APP removes: installation repos the user can no longer push to;
 *   3. AGENT removes: configured agent repos the user can no longer push to.
 * The agent's repos are only ever removed from, never added to.
 *
 * Apply takes the exact lists the admin confirmed and re-checks each against
 * the user's current access. The safety rules are the shared access rules
 * (accessSkipReason / orgSkipReason): unknown is never none, so an org whose
 * listing is missing, partial or failed, or whose lookup App is not installed
 * or selected-only, is skipped and reported (adds included); an unbound,
 * not-found or unverified user skips the whole call. More than
 * MAX_UNCONFIRMED_REMOVALS removals need confirmRemovals.
 *
 * Order: installation adds, installation removals, agent-repo removals, one
 * audit entry, then the agent's open work on the removed repos is blocked
 * through the optional OpenWorkPort (a port failure is a warning).
 */

import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import {
  identityOf,
  type InstallationReposPort,
} from "./installation-repos-service.ts";
import {
  MAX_UNCONFIRMED_REMOVALS,
  MISSING_APP_ID_REASON,
  type InstallationAgentRecord,
  type InstallationAgentsPort,
  type InstallationAuditPort,
} from "./installation-ports.ts";
import type { OpenWorkItem, OpenWorkPort } from "./reconcile-open-work.ts";
import {
  accessSkipReason,
  type OrgSkip,
  orgSkipReason,
  repoOrg,
} from "./repo-access-rules.ts";
import {
  blockRepoRemovalWork,
  previewRepoRemovalWork,
  repoLostAccessBlockReason,
} from "./repo-removal-open-work.ts";
import type { UserRepoAccessResult } from "./user-repo-access-resolver.ts";

/** `planHash` of the audit row a sync apply writes. */
export const GITHUB_SYNC_AUDIT_PLAN_HASH = "sync:apply";

export const STILL_PUSHABLE_REASON =
  "the bound user can still push to this repo";
export const NOT_ADDABLE_REASON = "the bound user cannot push to this repo";
export const ALREADY_INSTALLED_REASON = "already on the agent installation";
export const NOT_INSTALLED_ORG_REASON =
  "the agent App is not installed on this org";
export const NOT_PRESENT_REASON =
  "not on the agent installation or in the agent's repos";

export interface SyncLists {
  appAdds: readonly string[];
  appRemoves: readonly string[];
  agentRemoves: readonly string[];
}

export interface GithubSyncPlanInput {
  username: string | null | undefined;
  /** Null when the resolver was not run. */
  access: UserRepoAccessResult | null;
  agentRepos: readonly string[];
  /** Repos the agent App's installation covers, per org login it is installed on. */
  installationRepos: Readonly<Record<string, readonly string[]>>;
  /**
   * The lists the admin confirmed. When set, only these are candidates and
   * every one left alone is reported in `notApplied`; when unset (preview),
   * every eligible repo is a candidate.
   */
  requested?: SyncLists;
}

export interface NotAppliedRepo {
  repo: string;
  reason: string;
}

export interface GithubSyncPlan {
  skipped: boolean;
  skipReason?: string;
  appAdds: string[];
  appRemoves: string[];
  agentRemoves: string[];
  /** Every repo removed from either place, sorted. */
  removedRepos: string[];
  skippedOrgs: OrgSkip[];
  notApplied: NotAppliedRepo[];
  warnings: string[];
}

const lower = (s: string): string => s.toLowerCase();
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

function skippedPlan(reason: string): GithubSyncPlan {
  return {
    skipped: true,
    skipReason: reason,
    appAdds: [],
    appRemoves: [],
    agentRemoves: [],
    removedRepos: [],
    skippedOrgs: [],
    notApplied: [],
    warnings: [],
  };
}

/** Pure: the installation adds and removes and agent-repo removes to sync. */
export function planGithubSync(input: GithubSyncPlanInput): GithubSyncPlan {
  const skip = accessSkipReason(input.username, input.access);
  if (skip) return skippedPlan(skip);
  const access = input.access as UserRepoAccessResult;

  const orgResults = new Map(access.orgs.map((o) => [lower(o.org), o]));
  const pushable = new Map<string, string>();
  for (const o of access.orgs) {
    for (const r of o.repos)
      if (r.canPush) pushable.set(lower(r.fullName), r.fullName);
  }
  // Keyed by lower-case name; values keep the stored spelling.
  const installed = new Map<string, string>();
  const installedOrgs = new Set<string>();
  for (const [org, repos] of Object.entries(input.installationRepos)) {
    installedOrgs.add(lower(org));
    for (const r of repos) installed.set(lower(r), r);
  }
  const configured = new Map(input.agentRepos.map((r) => [lower(r), r]));

  const requested = input.requested;
  const addCandidates = requested
    ? requested.appAdds
    : [...pushable.values()].filter((r) =>
        installedOrgs.has(lower(repoOrg(r))),
      );
  const appRemoveCandidates = requested
    ? requested.appRemoves
    : [...installed.values()];
  const agentRemoveCandidates = requested
    ? requested.agentRemoves
    : [...configured.values()];

  const skipReasons = new Map<string, string>();
  const notApplied = new Map<string, NotAppliedRepo>();
  const leave = (repo: string, reason: string) => {
    if (requested)
      notApplied.set(`${lower(repo)}\0${reason}`, { repo, reason });
  };
  // Unknown is never none: false (with the reason recorded) for a skipped org.
  const orgUsable = (repo: string): boolean => {
    const org = repoOrg(repo);
    const reason = orgSkipReason(orgResults.get(lower(org)));
    if (!reason) return true;
    skipReasons.set(org, reason);
    leave(repo, `skipped for org: ${reason}`);
    return false;
  };

  const appAdds = new Set<string>();
  for (const repo of new Set(addCandidates)) {
    if (!orgUsable(repo)) continue;
    if (!installedOrgs.has(lower(repoOrg(repo)))) {
      leave(repo, NOT_INSTALLED_ORG_REASON);
      continue;
    }
    const name = pushable.get(lower(repo));
    if (!name) {
      leave(repo, NOT_ADDABLE_REASON);
      continue;
    }
    if (installed.has(lower(repo))) {
      leave(repo, ALREADY_INSTALLED_REASON);
      continue;
    }
    appAdds.add(name);
  }
  // Removal candidates must be present in the place they come out of and
  // not pushable by the user.
  const removable = (
    repos: Iterable<string>,
    present: Map<string, string>,
  ): Set<string> => {
    const out = new Set<string>();
    for (const repo of new Set(repos)) {
      if (!orgUsable(repo)) continue;
      if (pushable.has(lower(repo))) {
        leave(repo, STILL_PUSHABLE_REASON);
        continue;
      }
      const stored = present.get(lower(repo));
      if (!stored) {
        leave(repo, NOT_PRESENT_REASON);
        continue;
      }
      out.add(stored);
    }
    return out;
  };
  const appRemoves = removable(appRemoveCandidates, installed);
  const agentRemoves = removable(agentRemoveCandidates, configured);

  const skippedOrgs = sorted(skipReasons.keys()).map((org) => ({
    org,
    reason: skipReasons.get(org) as string,
  }));
  return {
    skipped: false,
    appAdds: sorted(appAdds),
    appRemoves: sorted(appRemoves),
    agentRemoves: sorted(agentRemoves),
    removedRepos: sorted(new Set([...appRemoves, ...agentRemoves])),
    skippedOrgs,
    notApplied: [...notApplied.values()].sort((a, b) =>
      a.repo.localeCompare(b.repo),
    ),
    warnings: skippedOrgs.map((s) => `${s.org}: skipped (${s.reason})`),
  };
}

export interface GithubSyncDeps {
  agents: InstallationAgentsPort;
  access: GithubAccessPreviewFn;
  installation: Pick<
    InstallationReposPort,
    "listInstalled" | "addRepos" | "removeRepos"
  >;
  audit: InstallationAuditPort;
  /** Optional: with none, nothing is listed or blocked. */
  openWork?: OpenWorkPort;
}

export type GithubSyncPreviewResult =
  | { status: "agent_not_found" }
  | { status: "skipped"; reason: string }
  | {
      status: "previewed";
      plan: GithubSyncPlan;
      openWork: OpenWorkItem[];
      warnings: string[];
    };

export interface GithubSyncApplyInput extends SyncLists {
  agentId: string;
  /** Who asked (audit trail). */
  caller: string;
  confirmRemovals?: boolean;
}

export type GithubSyncApplyResult =
  | { status: "agent_not_found" }
  | { status: "skipped"; reason: string }
  | { status: "noop"; plan: GithubSyncPlan }
  | { status: "removal_cap"; plan: GithubSyncPlan; removals: number }
  | {
      status: "applied";
      plan: GithubSyncPlan;
      auditId: string;
      warnings: string[];
    }
  | { status: "failed"; plan: GithubSyncPlan; auditId: string; error: string };

function groupByOrg(repos: readonly string[]): Map<string, string[]> {
  const byOrg = new Map<string, string[]>();
  for (const r of repos) {
    const org = repoOrg(r);
    byOrg.set(org, [...(byOrg.get(org) ?? []), r]);
  }
  return byOrg;
}

export class GithubSyncService {
  constructor(private readonly deps: GithubSyncDeps) {}

  /** Read-only: what would change and the open work the removals would block. */
  async preview(agentId: string): Promise<GithubSyncPreviewResult> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) return { status: "agent_not_found" };
    const plan = await this.planFor(agent);
    if (plan.skipped) {
      return { status: "skipped", reason: plan.skipReason ?? "skipped" };
    }
    const work = await previewRepoRemovalWork(
      this.deps.openWork,
      agentId,
      plan.removedRepos,
    );
    return {
      status: "previewed",
      plan,
      openWork: work.openWork,
      warnings: [...plan.warnings, ...work.warnings],
    };
  }

  async apply(input: GithubSyncApplyInput): Promise<GithubSyncApplyResult> {
    const agent = await this.deps.agents.get(input.agentId);
    if (!agent) return { status: "agent_not_found" };
    const plan = await this.planFor(agent, input);
    if (plan.skipped) {
      return { status: "skipped", reason: plan.skipReason ?? "skipped" };
    }
    if (plan.appAdds.length + plan.removedRepos.length === 0) {
      return { status: "noop", plan };
    }
    const removals = plan.removedRepos.length;
    if (removals > MAX_UNCONFIRMED_REMOVALS && !input.confirmRemovals) {
      return { status: "removal_cap", plan, removals };
    }

    const appId = agent.appId as number;
    const identity = identityOf(agent);
    const added: string[] = [];
    const removed: string[] = [];
    let configDone = false;
    let error: string | undefined;
    try {
      for (const [org, repos] of groupByOrg(plan.appAdds)) {
        await this.deps.installation.addRepos(appId, org, repos, identity);
        added.push(...repos);
      }
      for (const [org, repos] of groupByOrg(plan.appRemoves)) {
        await this.deps.installation.removeRepos(appId, org, repos, identity);
        removed.push(...repos);
      }
      if (plan.agentRemoves.length > 0) {
        const drop = new Set(plan.agentRemoves);
        await this.deps.agents.setRepos(
          agent.id,
          agent.repos.filter((r) => !drop.has(r)),
        );
      }
      configDone = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Record what actually changed; on failure, only what landed.
    const auditId = await this.deps.audit.write({
      agentId: input.agentId,
      caller: input.caller,
      planHash: GITHUB_SYNC_AUDIT_PLAN_HASH,
      diff: {
        installationAdds: added,
        installationRemoves: removed,
        configAdds: [],
        configRemoves: configDone ? plan.agentRemoves : [],
      },
      result:
        error === undefined
          ? { status: "applied" }
          : { status: "failed", error },
    });
    if (error !== undefined) {
      return { status: "failed", plan, auditId, error };
    }
    const warnings = await blockRepoRemovalWork(
      this.deps.openWork,
      input.agentId,
      plan.removedRepos,
      repoLostAccessBlockReason,
    );
    return { status: "applied", plan, auditId, warnings };
  }

  private async planFor(
    agent: InstallationAgentRecord,
    requested?: SyncLists,
  ): Promise<GithubSyncPlan> {
    const username = agent.githubUsername?.trim();
    if (!username) {
      return skippedPlan(accessSkipReason(username, null) as string);
    }
    const preview = await this.deps.access(username);
    if (preview.status === "unconfigured") {
      return skippedPlan("GitHub Apps are not configured");
    }
    // Whole-call skips need no installation calls.
    const skip = accessSkipReason(username, preview.access);
    if (skip) return skippedPlan(skip);
    if (agent.appId === undefined) return skippedPlan(MISSING_APP_ID_REASON);
    const installed = await this.deps.installation.listInstalled(
      agent.appId,
      identityOf(agent),
    );
    return planGithubSync({
      username,
      access: preview.access,
      agentRepos: agent.repos,
      installationRepos: Object.fromEntries(
        installed.map(({ org, repos }) => [org, repos]),
      ),
      ...(requested
        ? {
            requested: {
              appAdds: requested.appAdds,
              appRemoves: requested.appRemoves,
              agentRemoves: requested.agentRemoves,
            },
          }
        : {}),
    });
  }
}
