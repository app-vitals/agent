/**
 * admin/src/repo-access-rules.ts
 * Pure rules for deciding what a bound GitHub user's access result can safely
 * justify (reused by the lost-access removal, IRM-1.3). No I/O.
 *
 * - Unknown is never none: an org whose resolver result is missing, partial,
 *   failed, or whose lookup installation is selected-only is skipped (with a
 *   reason); so is everything when the user is unbound, not found or
 *   unverified.
 */

import {
  type OrgAccessResult,
  SELECTED_REPOS_REASON,
  type UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

export interface OrgSkip {
  org: string;
  reason: string;
}

export function repoOrg(fullName: string): string {
  return fullName.split("/")[0] ?? "";
}

/**
 * Why removals in one org must be skipped (unknown is never none): the org
 * was not checked, its listing is partial or failed, or the lookup App is
 * installed on selected repositories only. Undefined when the listing is
 * complete.
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

/**
 * Why a whole call must be skipped: no bound user, access not resolved, user
 * not found or not verified. Undefined when the access result is usable.
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
