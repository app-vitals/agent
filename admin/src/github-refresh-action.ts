/**
 * admin/src/github-refresh-action.ts
 * The fire-and-forget Refresh action (GLC-2.4). requestRefresh() only writes
 * to the database (ages the cache snapshots past the staleness cap, clears
 * crawl and access backoff) and asks discovery to run again; it never calls
 * GitHub and never waits on the refresher. The next tick does the work, still
 * behind the snapshot lease and the rate-limit window.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { GitHubRepoCacheService } from "./github-repo-cache.ts";

export interface RefreshRequestResult {
  snapshots: number;
  accessPairs: number;
}

export interface GithubRefreshAction {
  requestRefresh(): Promise<RefreshRequestResult>;
}

export function createGithubRefreshAction(deps: {
  cache: Pick<GitHubRepoCacheService, "markStale">;
  /** Snapshots are aged past this so the planner treats them as capped work. */
  stalenessCapMs: number;
  /** Runs after the mark (e.g. refresher.invalidateDiscovery). Failures are ignored. */
  onMarked?: () => void;
  clock?: Clock;
}): GithubRefreshAction {
  const clock = deps.clock ?? SystemClock();
  return {
    async requestRefresh() {
      const staleBefore = new Date(
        clock.now().getTime() - deps.stalenessCapMs - 1,
      );
      const res = await deps.cache.markStale(staleBefore);
      try {
        deps.onMarked?.();
      } catch {
        // discovery refresh is best effort
      }
      return res;
    },
  };
}
