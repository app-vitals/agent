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
 * An org whose agent installation is on "All repositories" (read from the
 * crawl cache; unknown is never "all") cannot take add/remove calls, so Sync
 * switches it to "selected" first (GIS-1.2): target = installed repos minus the
 * confirmed app removes for that org. The first MAX_SELECTION_PATCH_REPOS go in
 * the PATCH, the rest through the batched add. The org's removes fold into the
 * switch but still count in removedRepos. An empty target skips the org with a
 * warning and leaves it on "all".
 *
 * Order: selection switches, installation adds, installation removals,
 * agent-repo removals, one audit entry, then the agent's open work on the
 * removed repos is blocked through the optional OpenWorkPort (a port failure is
 * a warning).
 */

import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import { DEPLOYMENT_WIDE_ACCOUNT_KEY } from "./github-agent-installation-crawler.ts";
import {
  GITHUB_APPS_STATE_REASONS,
  type GithubAppsState,
  type GithubAppsStateFn,
} from "./github-apps-state.ts";
import { DEFAULT_REFRESH_STALENESS_CAP_MS } from "./github-repo-refresher.ts";
import {
  buildCachedAccess,
  type CachedOrgInput,
} from "./github-sync-cached-access.ts";
import {
  type InstallationAgentRecord,
  type InstallationAgentsPort,
  type InstallationAuditPort,
  MAX_UNCONFIRMED_REMOVALS,
  MISSING_APP_ID_REASON,
} from "./installation-ports.ts";
import {
  type InstallationCachePort,
  type InstallationReposPort,
  identityOf,
  NO_INSTALLATION_REASON,
} from "./installation-repos-service.ts";
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
import type {
  OrgSkipDetail,
  UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

/** `planHash` of the audit row a sync apply writes. */
export const GITHUB_SYNC_AUDIT_PLAN_HASH = "sync:apply";

export const STILL_PUSHABLE_REASON =
  "the bound user can still push to this repo";
export const NOT_ADDABLE_REASON = "the bound user cannot push to this repo";
export const ALREADY_INSTALLED_REASON = "already on the agent installation";
export const NOT_INSTALLED_ORG_REASON =
  "the agent App is not installed on this org";
export const REVERIFY_FAILED_REASON =
  "the live permission re-check failed, so the removal was dropped";
export const NOT_PRESENT_REASON =
  "not on the agent installation or in the agent's repos";
export const ARCHIVED_REASON =
  "the repo is archived (read-only), so it is not added to the installation";

/** GitHub caps the repositories in a selection-switch PATCH at 50. */
export const MAX_SELECTION_PATCH_REPOS = 50;

export const EMPTY_SWITCH_TARGET_REASON =
  "the bound user can push to none of this org's repos, so it cannot be switched to selected repositories and stays on All repositories; use Uninstall to remove the agent App from this org";

/** The installer App's permission a selection switch needs. */
export const SWITCH_PERMISSION_MESSAGE = (org: string): string =>
  `GitHub refused to switch the agent App on ${org} to selected repositories (403): the installer App needs the enterprise_organization_installation_repositories permission with write access`;

/** An "all" installation Sync switches to "selected" with this repo list. */
export interface SelectionSwitch {
  org: string;
  repos: string[];
}

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
   * The agent installation's repository selection per org (any case); a
   * missing or null entry is unknown and is never treated as "all".
   */
  selections?: Readonly<Record<string, "all" | "selected" | null | undefined>>;
  /**
   * The lists the admin confirmed. When set, only these are candidates and
   * every one left alone is reported in `notApplied`; when unset (preview),
   * every eligible repo is a candidate.
   */
  requested?: SyncLists;
  /**
   * Archived repos (owner/repo). They are never an installation add: an
   * archived repo is read-only. An archived repo already on the installation
   * is still removed when the access answer says the user cannot push. The
   * agent's own repos are unaffected.
   */
  archivedRepos?: readonly string[];
}

export interface NotAppliedRepo {
  repo: string;
  reason: string;
}

export interface GithubSyncPlan {
  skipped: boolean;
  skipReason?: string;
  /** Set when the skip is because an App role is missing (additive). */
  appsState?: Exclude<GithubAppsState, "both">;
  appAdds: string[];
  appRemoves: string[];
  agentRemoves: string[];
  /** Every repo removed from either place, sorted. */
  removedRepos: string[];
  /** "All" installations to switch to "selected" first (additive). */
  selectionSwitches?: SelectionSwitch[];
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
    selectionSwitches: [],
    skippedOrgs: [],
    notApplied: [],
    warnings: [],
  };
}

/**
 * Pure: the orgs on "all" and the "selected" list each switches to (installed
 * repos minus `appRemoves`). An org with an empty target is returned in
 * `emptyOrgs` instead. Only orgs `eligible` returns true for are considered.
 */
export function planSelectionSwitches(input: {
  installationRepos: Readonly<Record<string, readonly string[]>>;
  selections?: GithubSyncPlanInput["selections"];
  appRemoves: readonly string[];
  eligible?: (org: string) => boolean;
}): { switches: SelectionSwitch[]; emptyOrgs: string[] } {
  const selections = new Map(
    Object.entries(input.selections ?? {}).map(([o, v]) => [lower(o), v]),
  );
  const removed = new Set(input.appRemoves.map(lower));
  const switches: SelectionSwitch[] = [];
  const emptyOrgs: string[] = [];
  for (const [org, repos] of Object.entries(input.installationRepos)) {
    if (selections.get(lower(org)) !== "all") continue;
    if (input.eligible && !input.eligible(org)) continue;
    const target = sorted(repos.filter((r) => !removed.has(lower(r))));
    if (target.length === 0) emptyOrgs.push(org);
    else switches.push({ org, repos: target });
  }
  return {
    switches: switches.sort((a, b) => a.org.localeCompare(b.org)),
    emptyOrgs: emptyOrgs.sort(),
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
  const skipDetails = new Map<string, OrgSkipDetail>();
  const notApplied = new Map<string, NotAppliedRepo>();
  const leave = (repo: string, reason: string) => {
    if (requested)
      notApplied.set(`${lower(repo)}\0${reason}`, { repo, reason });
  };
  // Unknown is never none: false (with the reason recorded) for a skipped org.
  const orgUsable = (repo: string): boolean => {
    const org = repoOrg(repo);
    const result = orgResults.get(lower(org));
    const reason = orgSkipReason(result);
    if (!reason) return true;
    skipReasons.set(org, reason);
    if (result?.detail) skipDetails.set(org, result.detail);
    leave(repo, `skipped for org: ${reason}`);
    return false;
  };

  const archived = new Set((input.archivedRepos ?? []).map(lower));
  // Adds only; checked before orgUsable, so an archived repo never reports its
  // org skipped. Removals of installed archived repos take the normal path.
  const isArchived = (repo: string): boolean => {
    if (!archived.has(lower(repo))) return false;
    leave(repo, ARCHIVED_REASON);
    return true;
  };

  const appAdds = new Set<string>();
  for (const repo of new Set(addCandidates)) {
    if (isArchived(repo)) continue;
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
  // An archived repo still on the installation is removed like any other once
  // the user lacks push (least privilege); only adds skip archived repos.
  const confirmedAppRemoves = removable(appRemoveCandidates, installed);
  const agentRemoves = removable(agentRemoveCandidates, configured);

  const { switches, emptyOrgs } = planSelectionSwitches({
    installationRepos: input.installationRepos,
    ...(input.selections ? { selections: input.selections } : {}),
    appRemoves: [...confirmedAppRemoves],
    eligible: (o) => !orgSkipReason(orgResults.get(lower(o))),
  });
  // An empty target leaves the org on "all", where removes cannot be applied.
  const emptySet = new Set(emptyOrgs.map(lower));
  const appRemoves = new Set<string>();
  for (const r of confirmedAppRemoves) {
    if (emptySet.has(lower(repoOrg(r)))) leave(r, EMPTY_SWITCH_TARGET_REASON);
    else appRemoves.add(r);
  }
  for (const o of emptyOrgs) skipReasons.set(o, EMPTY_SWITCH_TARGET_REASON);

  const skippedOrgs = sorted(skipReasons.keys()).map((org) => ({
    org,
    reason: skipReasons.get(org) as string,
    ...(skipDetails.has(org) ? { detail: skipDetails.get(org) } : {}),
  }));
  return {
    skipped: false,
    appAdds: sorted(appAdds),
    appRemoves: sorted(appRemoves),
    agentRemoves: sorted(agentRemoves),
    removedRepos: sorted(new Set([...appRemoves, ...agentRemoves])),
    selectionSwitches: switches,
    skippedOrgs,
    notApplied: [...notApplied.values()].sort((a, b) =>
      a.repo.localeCompare(b.repo),
    ),
    warnings: skippedOrgs.map((s) => `${s.org}: skipped (${s.reason})`),
  };
}

/** One org's lookup-App crawl from the cache (adds are drawn from it). */
export interface CachedLookupOrg {
  org: string;
  completedAt: Date | null;
  /** The org's non-archived repos (owner/repo). */
  repos: readonly string[];
  /**
   * The org's archived repos (owner/repo), kept out of `repos`. GitHub Sync
   * never adds or removes them and needs no access answer for them, except
   * for one the agent has configured.
   */
  archivedRepos?: readonly string[];
  lastError?: string | null;
  rateLimitResetAt?: Date | null;
}

/** Default freshness bound: the refresher's staleness cap (the longest data is left unrefreshed). */
export const DEFAULT_SYNC_MAX_AGE_MS = DEFAULT_REFRESH_STALENESS_CAP_MS;

export interface GithubSyncDeps {
  agents: InstallationAgentsPort;
  /** Live resolver; used only when no `cache` is given. */
  access: GithubAccessPreviewFn;
  /**
   * The repo/access cache (GLC-2.3). When set, access is built from cached
   * rows and an org is used only while its data is complete and fresh.
   */
  cache?: InstallationCachePort;
  /** Cached lookup-App crawl per org, the source of installation adds. */
  lookupRepos?: (
    accountId: string | null | undefined,
  ) => Promise<CachedLookupOrg[]>;
  /** Freshness bound for cached data, ms. Default DEFAULT_SYNC_MAX_AGE_MS. */
  maxAgeMs?: number;
  now?: () => Date;
  /**
   * One live permission call for a removal candidate: true = the user can
   * still push, false = definitively cannot, undefined = could not tell.
   * Apply drops every candidate that is not definitively false.
   */
  verifyPush?: (
    username: string,
    repo: string,
    accountId?: string | null,
  ) => Promise<boolean | undefined>;
  installation: Pick<
    InstallationReposPort,
    "listInstalled" | "addRepos" | "removeRepos" | "setRepositorySelection"
  >;
  audit: InstallationAuditPort;
  /** Optional: with none, nothing is listed or blocked. */
  openWork?: OpenWorkPort;
  /** Optional: which Apps are usable; without both, Sync is skipped with a specific reason. */
  appsState?: GithubAppsStateFn;
}

export type GithubSyncPreviewResult =
  | { status: "agent_not_found" }
  | {
      status: "skipped";
      reason: string;
      appsState?: Exclude<GithubAppsState, "both">;
    }
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
  | {
      status: "skipped";
      reason: string;
      appsState?: Exclude<GithubAppsState, "both">;
    }
  | { status: "noop"; plan: GithubSyncPlan }
  | { status: "removal_cap"; plan: GithubSyncPlan; removals: number }
  | {
      status: "applied";
      plan: GithubSyncPlan;
      auditId: string;
      warnings: string[];
    }
  | { status: "failed"; plan: GithubSyncPlan; auditId: string; error: string };

/** A plan plus the installation context a re-verified plan recomputes switches from. */
interface PlannedSync {
  plan: GithubSyncPlan;
  installationRepos: Record<string, string[]>;
  selections?: Record<string, "all" | "selected" | null>;
}

/** A 403 on a selection switch becomes a message naming the missing permission. */
function switchError(org: string, err: unknown): Error {
  const e = err as { kind?: string; status?: number } | undefined;
  if (e?.kind === "permission" || (e?.status === 403 && e.kind === undefined)) {
    return new Error(SWITCH_PERMISSION_MESSAGE(org));
  }
  return err instanceof Error ? err : new Error(String(err));
}

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
    const { plan } = await this.planFor(agent);
    if (plan.skipped) {
      return {
        status: "skipped",
        reason: plan.skipReason ?? "skipped",
        ...(plan.appsState ? { appsState: plan.appsState } : {}),
      };
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
    const planned = await this.planFor(agent, input);
    let plan = planned.plan;
    if (plan.skipped) {
      return {
        status: "skipped",
        reason: plan.skipReason ?? "skipped",
        ...(plan.appsState ? { appsState: plan.appsState } : {}),
      };
    }
    plan = await this.reverifyRemovals(plan, agent, planned);
    const switches = plan.selectionSwitches ?? [];
    if (
      plan.appAdds.length + plan.removedRepos.length + switches.length ===
      0
    ) {
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
    const switchRecords: SelectionSwitch[] = [];
    const switchedOrgs = new Set(switches.map((s) => lower(s.org)));
    let configDone = false;
    let error: string | undefined;
    try {
      for (const sw of switches) {
        const record: SelectionSwitch = { org: sw.org, repos: [] };
        const head = sw.repos.slice(0, MAX_SELECTION_PATCH_REPOS);
        const rest = sw.repos.slice(MAX_SELECTION_PATCH_REPOS);
        const setSelection = this.deps.installation.setRepositorySelection;
        if (!setSelection) {
          throw new Error(
            `cannot switch ${sw.org} to selected repositories: the installation port does not support it`,
          );
        }
        try {
          await setSelection.call(
            this.deps.installation,
            appId,
            sw.org,
            head,
            identity,
          );
        } catch (err) {
          throw switchError(sw.org, err);
        }
        // The switch landed: the org's confirmed removes are now off the installation.
        record.repos = head;
        switchRecords.push(record);
        removed.push(
          ...plan.appRemoves.filter((r) => lower(repoOrg(r)) === lower(sw.org)),
        );
        if (rest.length > 0) {
          await this.deps.installation.addRepos(appId, sw.org, rest, identity);
          record.repos = sw.repos;
        }
      }
      for (const [org, repos] of groupByOrg(plan.appAdds)) {
        await this.deps.installation.addRepos(appId, org, repos, identity);
        added.push(...repos);
      }
      for (const [org, repos] of groupByOrg(plan.appRemoves)) {
        if (switchedOrgs.has(lower(org))) continue;
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
        ...(switchRecords.length > 0
          ? { selectionSwitches: switchRecords }
          : {}),
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

  /** Drops every removal the live permission call does not confirm (unknown is never none). */
  private async reverifyRemovals(
    plan: GithubSyncPlan,
    agent: InstallationAgentRecord,
    planned: PlannedSync,
  ): Promise<GithubSyncPlan> {
    const verify = this.deps.verifyPush;
    const username = agent.githubUsername?.trim();
    if (!verify || !username || plan.removedRepos.length === 0) return plan;
    const dropped = new Map<string, string>();
    for (const repo of plan.removedRepos) {
      let pushable: boolean | undefined;
      try {
        pushable = await verify(username, repo, agent.accountId);
      } catch {
        pushable = undefined;
      }
      if (pushable === false) continue;
      dropped.set(
        repo,
        pushable === true ? STILL_PUSHABLE_REASON : REVERIFY_FAILED_REASON,
      );
    }
    if (dropped.size === 0) return plan;
    const keep = (repos: string[]) => repos.filter((r) => !dropped.has(r));
    const appRemoves = keep(plan.appRemoves);
    const agentRemoves = keep(plan.agentRemoves);
    // A removal the user can still push to goes back on the switch target.
    const switchOrgs = new Set(
      (plan.selectionSwitches ?? []).map((s) => lower(s.org)),
    );
    const { switches } = planSelectionSwitches({
      installationRepos: planned.installationRepos,
      ...(planned.selections ? { selections: planned.selections } : {}),
      appRemoves,
      eligible: (o) => switchOrgs.has(lower(o)),
    });
    return {
      ...plan,
      appRemoves,
      agentRemoves,
      selectionSwitches: switches,
      removedRepos: sorted(new Set([...appRemoves, ...agentRemoves])),
      notApplied: [
        ...plan.notApplied,
        ...[...dropped].map(([repo, reason]) => ({ repo, reason })),
      ].sort((a, b) => a.repo.localeCompare(b.repo)),
    };
  }

  /**
   * Access from the cache (complete and fresh orgs only), with the installed
   * orgs, plus the archived repos the lookup crawl reported. An archived repo
   * is left out of an org's required access rows unless the agent has it
   * configured or it is on the installation (the refresher probes those so a
   * removal has an answer), since it does not check the others.
   */
  private async cachedAccess(
    agent: InstallationAgentRecord,
    username: string,
    installed: { org: string; repos: string[] }[],
  ): Promise<{
    access: UserRepoAccessResult;
    archivedRepos: string[];
    selections: Record<string, "all" | "selected" | null>;
  }> {
    const cache = this.deps.cache as InstallationCachePort;
    const accountId = agent.accountId || DEPLOYMENT_WIDE_ACCOUNT_KEY;
    const now = (this.deps.now ?? (() => new Date()))();
    const maxAgeMs = this.deps.maxAgeMs ?? DEFAULT_SYNC_MAX_AGE_MS;
    let agentSnaps: Awaited<
      ReturnType<InstallationCachePort["listAgentSnapshots"]>
    > = [];
    let lookup: CachedLookupOrg[] = [];
    let readFailed = false;
    try {
      agentSnaps = await cache.listAgentSnapshots(
        accountId,
        String(agent.appId),
      );
      if (this.deps.lookupRepos)
        lookup = await this.deps.lookupRepos(agent.accountId);
    } catch {
      readFailed = true;
    }
    const key = (s: string) => s.toLowerCase();
    const archivedRepos = lookup.flatMap((l) => l.archivedRepos ?? []);
    const archived = new Set(archivedRepos.map(key));
    const configuredKeys = new Set(agent.repos.map(key));
    const installedKeys = new Set(installed.flatMap((i) => i.repos.map(key)));
    const orgNames = new Map<string, string>();
    for (const i of installed) orgNames.set(key(i.org), i.org);
    for (const r of agent.repos) {
      const o = repoOrg(r);
      if (o && !orgNames.has(key(o))) orgNames.set(key(o), o);
    }
    const inputs: CachedOrgInput[] = [];
    for (const [k, org] of orgNames) {
      const inst = installed.find((i) => key(i.org) === k);
      const snap = agentSnaps.find((s) => key(s.org) === k);
      const lk = lookup.filter((l) => key(l.org) === k);
      const repos = new Map<string, string>();
      for (const r of [
        ...(inst?.repos ?? []),
        ...agent.repos.filter((r) => key(repoOrg(r)) === k),
        ...lk.flatMap((l) => l.repos),
      ]) {
        if (
          archived.has(key(r)) &&
          !configuredKeys.has(key(r)) &&
          !installedKeys.has(key(r))
        )
          continue;
        repos.set(key(r), r);
      }
      const crawls = [
        ...(inst && snap
          ? [
              {
                completedAt: snap.completedAt,
                lastError: snap.lastError,
                rateLimitResetAt: snap.rateLimitResetAt,
              },
            ]
          : []),
        ...lk.map((l) => ({
          completedAt: l.completedAt,
          ...(l.lastError === undefined ? {} : { lastError: l.lastError }),
          ...(l.rateLimitResetAt === undefined
            ? {}
            : { rateLimitResetAt: l.rateLimitResetAt }),
        })),
      ];
      let rows: Awaited<ReturnType<InstallationCachePort["getAccessRows"]>> =
        [];
      let failed = readFailed;
      if (!failed && repos.size > 0) {
        try {
          rows = await cache.getAccessRows({
            accountId,
            org,
            username,
            repos: [...repos.values()].map((f) => f.slice(f.indexOf("/") + 1)),
          });
        } catch {
          failed = true;
        }
      }
      inputs.push({
        org,
        crawls,
        ...(this.deps.lookupRepos !== undefined
          ? { lookupSnapshotFound: lk.length > 0 }
          : {}),
        // A read failure, an installed org with no crawl, or a lookup source with no crawl of this org.
        crawlMissing:
          failed ||
          (inst !== undefined && !snap) ||
          (this.deps.lookupRepos !== undefined && lk.length === 0),
        repos: [...repos.values()],
        rows,
      });
    }
    // Unknown (a read failure, no crawl, no recorded value) is never "all".
    const selections: Record<string, "all" | "selected" | null> = {};
    for (const s of agentSnaps) {
      selections[s.org] = s.repositorySelection ?? null;
    }
    return {
      access: buildCachedAccess({ username, now, maxAgeMs, orgs: inputs }),
      archivedRepos,
      selections,
    };
  }

  private async planFor(
    agent: InstallationAgentRecord,
    requested?: SyncLists,
  ): Promise<PlannedSync> {
    const none = (plan: GithubSyncPlan): PlannedSync => ({
      plan,
      installationRepos: {},
    });
    const username = agent.githubUsername?.trim();
    if (!username) {
      return none(skippedPlan(accessSkipReason(username, null) as string));
    }
    if (this.deps.appsState) {
      const state = await this.deps.appsState(agent.accountId);
      if (state !== "both") {
        return none({
          ...skippedPlan(GITHUB_APPS_STATE_REASONS[state]),
          appsState: state,
        });
      }
    }
    let liveAccess: UserRepoAccessResult | null = null;
    if (!this.deps.cache) {
      const preview = await this.deps.access(username, agent.accountId);
      if (preview.status === "unconfigured") {
        return none(skippedPlan("GitHub Apps are not configured"));
      }
      // Whole-call skips need no installation calls.
      const skip = accessSkipReason(username, preview.access);
      if (skip) return none(skippedPlan(skip));
      liveAccess = preview.access;
    }
    if (agent.appId === undefined) {
      return none(skippedPlan(MISSING_APP_ID_REASON));
    }
    const installed = await this.deps.installation.listInstalled(
      agent.appId,
      identityOf(agent),
    );
    if (installed.status === "none") {
      return none(skippedPlan(NO_INSTALLATION_REASON));
    }
    // The live resolver reports no archived flag, so only the cached path
    // leaves archived repos alone.
    const cached = liveAccess
      ? undefined
      : await this.cachedAccess(agent, username, installed.orgs);
    // The live path never reads the crawl cache, so every selection is unknown.
    const selections = cached?.selections;
    const installationRepos = Object.fromEntries(
      installed.orgs.map(({ org, repos }) => [org, repos]),
    );
    const plan = planGithubSync({
      username,
      access: liveAccess ?? (cached?.access as UserRepoAccessResult),
      ...(cached && cached.archivedRepos.length > 0
        ? { archivedRepos: cached.archivedRepos }
        : {}),
      agentRepos: agent.repos,
      installationRepos,
      ...(selections ? { selections } : {}),
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
    return {
      plan,
      installationRepos,
      ...(selections ? { selections } : {}),
    };
  }
}
