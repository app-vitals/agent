/**
 * admin/src/reconcile-planner.ts
 * ReconcilePlanner: pure planning half of the repo reconcile (GHE-3.2). Turns
 * a UserRepoAccessResolver result, the agent's repos and the agent App's
 * installation repositories into a diff plus a stable plan hash. No I/O.
 *
 * Rules:
 * - Desired agent repos = current repos kept only where the bound user can
 *   push. Newly accessible repos are never added; adds happen only when the
 *   admin names them, and only if push-capable and not basename-colliding.
 * - Removals never come from incomplete knowledge: an org whose resolver
 *   result is missing, partial, failed, or whose lookup installation is
 *   selected-only is skipped (with a reason); so is everything when the
 *   user is unbound, not found or unverified.
 * - Agent repos stay a subset of installation repos. A removed repo leaves
 *   the installation too; an add is installed first when absent.
 * - Planning over an already-reconciled state is an empty diff with the same
 *   hash.
 */

import { createHash } from "node:crypto";
import {
  type OrgAccessResult,
  SELECTED_REPOS_REASON,
  type UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

export interface ReconcilePlanInput {
  /** Bound GitHub username; null/empty yields a skipped plan. */
  username: string | null | undefined;
  /** Null when the resolver was not run (no bound user). */
  access: UserRepoAccessResult | null;
  /** The agent's configured repos, owner/repo. */
  agentRepos: readonly string[];
  /** Repos the agent App's installation covers, per org login. */
  installationRepos: Readonly<Record<string, readonly string[]>>;
  /** Repos the admin explicitly asks to add, owner/repo. */
  namedAdds?: readonly string[];
}

export interface OrgSkip {
  org: string;
  reason: string;
}

export interface RejectedAdd {
  repo: string;
  reason: string;
}

export interface ReconcileDiff {
  installationAdds: string[];
  installationRemoves: string[];
  configAdds: string[];
  configRemoves: string[];
}

export interface ReconcilePlan {
  skipped: boolean;
  /** Set when the whole plan is skipped. */
  skipReason?: string;
  diff: ReconcileDiff;
  skippedOrgs: OrgSkip[];
  rejectedAdds: RejectedAdd[];
  warnings: string[];
  empty: boolean;
  planHash: string;
}

const EMPTY_DIFF = (): ReconcileDiff => ({
  installationAdds: [],
  installationRemoves: [],
  configAdds: [],
  configRemoves: [],
});

export function repoOrg(fullName: string): string {
  return fullName.split("/")[0] ?? "";
}

export function repoBasename(fullName: string): string {
  return (fullName.split("/")[1] ?? fullName).toLowerCase();
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/**
 * Why removals in one org must be skipped (unknown is never none): the org
 * was not checked, its listing is partial or failed, or the lookup App is
 * installed on selected repositories only. Undefined when the listing is
 * complete. Shared with the lost-access removal (IRM-1.3).
 */
export function orgSkipReason(
  result: OrgAccessResult | undefined,
): string | undefined {
  if (!result) return "org was not checked";
  if (result.reason === SELECTED_REPOS_REASON) {
    return "lookup app is installed on selected repositories only";
  }
  if (result.status === "partial") return "access listing is incomplete";
  if (result.status !== "ok") return `access lookup failed: ${result.status}`;
  return undefined;
}

function hashPlan(
  username: string,
  diff: ReconcileDiff,
  skippedOrgs: OrgSkip[],
  rejectedAdds: RejectedAdd[],
  skipReason: string | undefined,
): string {
  const canonical = JSON.stringify({
    username: username.toLowerCase(),
    diff,
    skippedOrgs,
    rejectedAdds,
    skipReason: skipReason ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function finish(
  username: string,
  plan: Omit<ReconcilePlan, "empty" | "planHash">,
): ReconcilePlan {
  const d = plan.diff;
  const empty =
    d.installationAdds.length +
      d.installationRemoves.length +
      d.configAdds.length +
      d.configRemoves.length ===
    0;
  return {
    ...plan,
    empty,
    planHash: hashPlan(
      username,
      d,
      plan.skippedOrgs,
      plan.rejectedAdds,
      plan.skipReason,
    ),
  };
}

function skippedPlan(username: string, reason: string): ReconcilePlan {
  return finish(username, {
    skipped: true,
    skipReason: reason,
    diff: EMPTY_DIFF(),
    skippedOrgs: [],
    rejectedAdds: [],
    warnings: [],
  });
}

/**
 * Why a whole plan must be skipped: no bound user, access not resolved, user
 * not found or not verified. Undefined when the access result is usable.
 * Shared with the lost-access removal (IRM-1.3).
 */
export function accessSkipReason(
  username: string | null | undefined,
  access: UserRepoAccessResult | null,
): string | undefined {
  if (!username?.trim()) return "no GitHub username bound to the agent";
  if (!access) return "access was not resolved";
  if (access.outcome === "user_not_found") return "GitHub user not found";
  if (!access.userVerified) return "GitHub user could not be verified";
  return undefined;
}

export function planReconcile(input: ReconcilePlanInput): ReconcilePlan {
  const username = input.username?.trim() ?? "";
  const skipReason = accessSkipReason(username, input.access);
  if (skipReason) return skippedPlan(username, skipReason);
  const access = input.access as UserRepoAccessResult;

  const orgResults = new Map(access.orgs.map((o) => [o.org, o]));
  const pushable = new Set<string>();
  for (const o of access.orgs) {
    for (const r of o.repos) if (r.canPush) pushable.add(r.fullName);
  }

  const installation = new Set<string>();
  for (const repos of Object.values(input.installationRepos)) {
    for (const r of repos) installation.add(r);
  }

  const warnings: string[] = [];
  const skipReasons = new Map<string, string>();
  const checkOrg = (org: string): string | undefined => {
    if (!skipReasons.has(org)) {
      const reason = orgSkipReason(orgResults.get(org));
      if (reason) skipReasons.set(org, reason);
    }
    return skipReasons.get(org);
  };

  const agentRepos = new Set(input.agentRepos);
  const configRemoves = new Set<string>();
  for (const repo of sorted(agentRepos)) {
    const org = repoOrg(repo);
    if (checkOrg(org)) continue; // Unknown is never none.
    if (!pushable.has(repo)) {
      configRemoves.add(repo);
    } else if (!installation.has(repo)) {
      // Keeps agent repos a subset of installation repos.
      configRemoves.add(repo);
      warnings.push(`${repo} is not in the agent installation; dropping it`);
    }
  }
  const kept = new Set([...agentRepos].filter((r) => !configRemoves.has(r)));

  const configAdds = new Set<string>();
  const installationAdds = new Set<string>();
  const rejectedAdds: RejectedAdd[] = [];
  const reject = (repo: string, reason: string) =>
    rejectedAdds.push({ repo, reason });
  const basenames = new Map<string, string>();
  for (const r of sorted(kept)) basenames.set(repoBasename(r), r);

  for (const repo of sorted(new Set(input.namedAdds ?? []))) {
    if (kept.has(repo)) continue; // Already present: nothing to add.
    if (!pushable.has(repo)) {
      reject(repo, "user cannot push to this repo");
      continue;
    }
    const clash = basenames.get(repoBasename(repo));
    if (clash) {
      reject(repo, `basename collides with ${clash}`);
      continue;
    }
    basenames.set(repoBasename(repo), repo);
    configAdds.add(repo);
    if (!installation.has(repo)) installationAdds.add(repo);
  }

  // Installation removals follow config removals, only for installed repos.
  const installationRemoves = [...configRemoves].filter((r) =>
    installation.has(r),
  );

  const skippedOrgs = sorted(skipReasons.keys()).map((org) => ({
    org,
    reason: skipReasons.get(org) as string,
  }));
  for (const s of skippedOrgs) {
    warnings.push(`${s.org}: removals skipped (${s.reason})`);
  }

  return finish(username, {
    skipped: false,
    diff: {
      installationAdds: sorted(installationAdds),
      installationRemoves: sorted(installationRemoves),
      configAdds: sorted(configAdds),
      configRemoves: sorted(configRemoves),
    },
    skippedOrgs,
    rejectedAdds,
    warnings,
  });
}
