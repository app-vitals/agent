/**
 * admin/src/lost-access-removal.ts
 * Lost-access removal (IRM-1.3): removes, from both the agent App's
 * installation and the agent's own repos, every repo the agent's bound GitHub
 * user can no longer push to. It never adds repos.
 *
 * The admin reviews a read-only preview, then sends the exact repos they
 * confirmed; the server re-checks each against the user's current access and
 * removes only those still without it (no plan hash). The safety rules are the
 * shared access rules (accessSkipReason / orgSkipReason): unknown is never
 * none, so orgs with a missing, partial or failed listing, or a selected-only
 * lookup install, are skipped and reported; an unbound, not-found or
 * unverified user skips the whole call. More than MAX_UNCONFIRMED_REMOVALS
 * removals need confirmRemovals.
 *
 * Order: installation removals, then the agent's repos, then one audit entry,
 * then the agent's open work on the removed repos is blocked through the
 * optional OpenWorkPort (a port failure is a warning, never a failed call).
 */

import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";
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

/** `planHash` of the audit row a lost-access removal writes. */
export const LOST_ACCESS_AUDIT_PLAN_HASH = "lost-access:remove";

export const STILL_PUSHABLE_REASON =
  "the bound user can still push to this repo";
export const NOT_PRESENT_REASON =
  "not on the agent installation or in the agent's repos";

export interface LostAccessPlanInput {
  username: string | null | undefined;
  /** Null when the resolver was not run. */
  access: UserRepoAccessResult | null;
  agentRepos: readonly string[];
  /** Repos the agent App's installation covers, per org login. */
  installationRepos: Readonly<Record<string, readonly string[]>>;
  /**
   * The repos the admin confirmed. When set, only these are candidates and
   * every one left alone is reported in `notRemoved`; when unset (preview),
   * every installation and agent repo is a candidate.
   */
  requested?: readonly string[];
}

export interface NotRemovedRepo {
  repo: string;
  reason: string;
}

export interface LostAccessPlan {
  skipped: boolean;
  skipReason?: string;
  /** Every repo removed from either place, sorted. */
  repos: string[];
  installationRemoves: string[];
  configRemoves: string[];
  skippedOrgs: OrgSkip[];
  notRemoved: NotRemovedRepo[];
  warnings: string[];
}

const lower = (s: string): string => s.toLowerCase();
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

function skippedPlan(reason: string): LostAccessPlan {
  return {
    skipped: true,
    skipReason: reason,
    repos: [],
    installationRemoves: [],
    configRemoves: [],
    skippedOrgs: [],
    notRemoved: [],
    warnings: [],
  };
}

/** Pure: the repos to remove because the bound user lost push access. */
export function planLostAccessRemoval(
  input: LostAccessPlanInput,
): LostAccessPlan {
  const skip = accessSkipReason(input.username, input.access);
  if (skip) return skippedPlan(skip);
  const access = input.access as UserRepoAccessResult;

  const orgResults = new Map(access.orgs.map((o) => [lower(o.org), o]));
  const pushable = new Set<string>();
  for (const o of access.orgs) {
    for (const r of o.repos) if (r.canPush) pushable.add(lower(r.fullName));
  }
  // Keyed by lower-case name; values keep the stored spelling.
  const installed = new Map<string, string>();
  for (const repos of Object.values(input.installationRepos)) {
    for (const r of repos) installed.set(lower(r), r);
  }
  const configured = new Map(input.agentRepos.map((r) => [lower(r), r]));

  const candidates = input.requested
    ? sorted(new Set(input.requested))
    : sorted(new Set([...configured.values(), ...installed.values()]));

  const skipReasons = new Map<string, string>();
  const notRemoved: NotRemovedRepo[] = [];
  const leave = (repo: string, reason: string) => {
    if (input.requested) notRemoved.push({ repo, reason });
  };
  const installationRemoves = new Set<string>();
  const configRemoves = new Set<string>();
  for (const repo of candidates) {
    const org = repoOrg(repo);
    const orgSkip = orgSkipReason(orgResults.get(lower(org)));
    if (orgSkip) {
      // Unknown is never none.
      skipReasons.set(org, orgSkip);
      leave(repo, `removals skipped for org: ${orgSkip}`);
      continue;
    }
    if (pushable.has(lower(repo))) {
      leave(repo, STILL_PUSHABLE_REASON);
      continue;
    }
    const inInstallation = installed.get(lower(repo));
    const inConfig = configured.get(lower(repo));
    if (!inInstallation && !inConfig) {
      leave(repo, NOT_PRESENT_REASON);
      continue;
    }
    if (inInstallation) installationRemoves.add(inInstallation);
    if (inConfig) configRemoves.add(inConfig);
  }

  const skippedOrgs = sorted(skipReasons.keys()).map((org) => ({
    org,
    reason: skipReasons.get(org) as string,
  }));
  return {
    skipped: false,
    repos: sorted(new Set([...installationRemoves, ...configRemoves])),
    installationRemoves: sorted(installationRemoves),
    configRemoves: sorted(configRemoves),
    skippedOrgs,
    notRemoved,
    warnings: skippedOrgs.map(
      (s) => `${s.org}: removals skipped (${s.reason})`,
    ),
  };
}

export interface LostAccessRemovalDeps {
  agents: InstallationAgentsPort;
  access: GithubAccessPreviewFn;
  installation: Pick<InstallationReposPort, "listInstalled" | "removeRepos">;
  audit: InstallationAuditPort;
  /** Optional: with none, nothing is listed or blocked. */
  openWork?: OpenWorkPort;
}

export type LostAccessPreviewResult =
  | { status: "agent_not_found" }
  | { status: "skipped"; reason: string }
  | {
      status: "previewed";
      plan: LostAccessPlan;
      openWork: OpenWorkItem[];
      warnings: string[];
    };

export interface LostAccessRemoveInput {
  agentId: string;
  /** Who asked (audit trail). */
  caller: string;
  /** The repos the admin confirmed from the preview. */
  repos: readonly string[];
  confirmRemovals?: boolean;
}

export type LostAccessRemoveResult =
  | { status: "agent_not_found" }
  | { status: "skipped"; reason: string }
  | { status: "noop"; plan: LostAccessPlan }
  | { status: "removal_cap"; plan: LostAccessPlan; removals: number }
  | {
      status: "applied";
      plan: LostAccessPlan;
      auditId: string;
      warnings: string[];
    }
  | { status: "failed"; plan: LostAccessPlan; auditId: string; error: string };

function groupByOrg(repos: readonly string[]): Map<string, string[]> {
  const byOrg = new Map<string, string[]>();
  for (const r of repos) {
    const org = repoOrg(r);
    byOrg.set(org, [...(byOrg.get(org) ?? []), r]);
  }
  return byOrg;
}

export class LostAccessRemovalService {
  constructor(private readonly deps: LostAccessRemovalDeps) {}

  /** Read-only: what would be removed and the open work it would block. */
  async preview(agentId: string): Promise<LostAccessPreviewResult> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) return { status: "agent_not_found" };
    const plan = await this.planFor(agent);
    if (plan.skipped) {
      return { status: "skipped", reason: plan.skipReason ?? "skipped" };
    }
    const work = await previewRepoRemovalWork(
      this.deps.openWork,
      agentId,
      plan.repos,
    );
    return {
      status: "previewed",
      plan,
      openWork: work.openWork,
      warnings: [...plan.warnings, ...work.warnings],
    };
  }

  async remove(input: LostAccessRemoveInput): Promise<LostAccessRemoveResult> {
    const agent = await this.deps.agents.get(input.agentId);
    if (!agent) return { status: "agent_not_found" };
    const plan = await this.planFor(agent, input.repos);
    if (plan.skipped) {
      return { status: "skipped", reason: plan.skipReason ?? "skipped" };
    }
    if (plan.repos.length === 0) return { status: "noop", plan };
    const removals = plan.repos.length;
    if (removals > MAX_UNCONFIRMED_REMOVALS && !input.confirmRemovals) {
      return { status: "removal_cap", plan, removals };
    }

    const appId = agent.appId as number;
    const removedFromInstallation: string[] = [];
    let configDone = false;
    let error: string | undefined;
    try {
      for (const [org, repos] of groupByOrg(plan.installationRemoves)) {
        await this.deps.installation.removeRepos(appId, org, repos);
        removedFromInstallation.push(...repos);
      }
      if (plan.configRemoves.length > 0) {
        const drop = new Set(plan.configRemoves);
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
      planHash: LOST_ACCESS_AUDIT_PLAN_HASH,
      diff: {
        installationAdds: [],
        installationRemoves: removedFromInstallation,
        configAdds: [],
        configRemoves: configDone ? plan.configRemoves : [],
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
      plan.repos,
      repoLostAccessBlockReason,
    );
    return { status: "applied", plan, auditId, warnings };
  }

  private async planFor(
    agent: InstallationAgentRecord,
    requested?: readonly string[],
  ): Promise<LostAccessPlan> {
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
    const installed = await this.deps.installation.listInstalled(agent.appId);
    return planLostAccessRemoval({
      username,
      access: preview.access,
      agentRepos: agent.repos,
      installationRepos: Object.fromEntries(
        installed.map(({ org, repos }) => [org, repos]),
      ),
      ...(requested ? { requested } : {}),
    });
  }
}
