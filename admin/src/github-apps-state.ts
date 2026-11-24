/**
 * admin/src/github-apps-state.ts
 * Which of the two enterprise GitHub Apps are usable. The lookup App backs the
 * repo crawl/cache, the repo picker and the access preview; the installer App
 * (GitHub Enterprise Cloud only) backs listing or changing the agent App's
 * installation repos, Sync adds/removes and install-on-org. Three states, so
 * "lookup missing" is never confused with "installer missing".
 */

export type GithubAppsState = "both" | "lookup_only" | "lookup_missing";

/** Resolves the state for an account; undefined account = deployment-wide. */
export type GithubAppsStateFn = (
  accountId?: string | null,
) => Promise<GithubAppsState>;

/** Lookup-only: repo access is visible, the installer-dependent surfaces are not. */
export const LOOKUP_ONLY_REASON =
  "Only the lookup GitHub App is configured, so repo access is visible but Sync and the agent App's installation repos need an enterprise installer App (GitHub Enterprise Cloud).";

/** Lookup App missing (with or without the installer App). */
export const LOOKUP_MISSING_REASON =
  "The lookup GitHub App is not configured, so repo access cannot be checked. Configure the lookup App first.";

export const GITHUB_APPS_STATE_REASONS: Record<
  Exclude<GithubAppsState, "both">,
  string
> = {
  lookup_only: LOOKUP_ONLY_REASON,
  lookup_missing: LOOKUP_MISSING_REASON,
};
