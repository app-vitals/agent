/**
 * admin/src/github-sync-cached-access.ts
 * Builds the bound user's access result for GitHub Sync from the repo/access
 * cache (GLC-2.3). No GitHub call, no I/O: callers pass the cached rows.
 *
 * An org is usable (status ok) only when its data is complete and fresh:
 *   - every required crawl snapshot has completed;
 *   - every repo in the org has an ok access row;
 *   - every one of those rows (and each completed crawl) was checked within
 *     maxAgeMs of now.
 * Otherwise the org is reported partial with a reason and no repos, so the
 * shared access rules skip it (unknown is never none): incomplete data wins
 * over stale data when both apply.
 */

import type { CachedAccessRow } from "./installation-repos-service.ts";
import {
  INCOMPLETE_ACCESS_REASON,
  staleAccessReason,
} from "./repo-access-rules.ts";
import {
  canPushForRole,
  type OrgAccessResult,
  type ResolvedRepoAccess,
  type UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";
import type { RepoRole } from "./github-lookup-client.ts";

export interface CachedOrgInput {
  org: string;
  /** completedAt of each crawl snapshot this org depends on; null = not completed. Empty = none needed. */
  crawls: { completedAt: Date | null }[];
  /** True when a crawl snapshot that must exist does not. */
  crawlMissing?: boolean;
  /** Every repo (full name) that needs an answer. */
  repos: string[];
  /** Cached access rows for the user over those repos. */
  rows: readonly CachedAccessRow[];
}

const ROLES = new Set<string>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);

const nameOf = (fullName: string): string =>
  fullName.slice(fullName.indexOf("/") + 1).toLowerCase();

export function buildCachedAccess(opts: {
  username: string;
  now: Date;
  maxAgeMs: number;
  orgs: readonly CachedOrgInput[];
}): UserRepoAccessResult {
  const staleBefore = opts.now.getTime() - opts.maxAgeMs;
  const orgs: OrgAccessResult[] = [];
  for (const o of opts.orgs) {
    const byRepo = new Map(o.rows.map((r) => [r.repo.toLowerCase(), r]));
    const answers = o.repos.map((f) => ({
      fullName: f,
      row: byRepo.get(nameOf(f)),
    }));
    const missing = answers.filter((a) => a.row?.status !== "ok");
    const incomplete =
      o.crawlMissing === true ||
      o.crawls.some((c) => c.completedAt === null) ||
      missing.length > 0;
    if (incomplete) {
      orgs.push({
        org: o.org,
        status: "partial",
        repos: [],
        unresolved: missing.length,
        reason: INCOMPLETE_ACCESS_REASON,
      });
      continue;
    }
    const times = [
      ...o.crawls.map((c) => c.completedAt as Date),
      ...answers.map((a) => a.row?.checkedAt),
    ];
    const unknownTime = times.some((t) => t === undefined);
    const known = times.filter((t): t is Date => t !== undefined);
    const oldest = known.sort((a, b) => a.getTime() - b.getTime())[0];
    if (unknownTime || (oldest && oldest.getTime() < staleBefore)) {
      orgs.push({
        org: o.org,
        status: "partial",
        repos: [],
        unresolved: 0,
        reason: staleAccessReason(unknownTime ? undefined : oldest),
      });
      continue;
    }
    const repos: ResolvedRepoAccess[] = answers.map(({ fullName, row }) => {
      const level: RepoRole = ROLES.has(row?.level ?? "")
        ? (row?.level as RepoRole)
        : row?.canPush
          ? "write"
          : "read";
      return {
        fullName,
        level,
        canPush: row?.canPush ?? canPushForRole(level),
      };
    });
    orgs.push({ org: o.org, status: "ok", repos, unresolved: 0 });
  }
  const unresolved = orgs.reduce((a, o) => a + o.unresolved, 0);
  return {
    username: opts.username,
    outcome: "ok",
    // Per-org gating decides what is usable; a nonexistent user is also
    // caught by the live re-check before any removal is applied.
    userVerified: true,
    orgs,
    unresolved,
    complete: orgs.length > 0 && orgs.every((o) => o.status === "ok"),
    checkedAt: opts.now.toISOString(),
  };
}
