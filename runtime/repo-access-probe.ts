/**
 * runtime/repo-access-probe.ts
 *
 * Per-repo GitHub access probe (COS-44.1). For each repo in the agent's scope it
 * calls GET /repos/{owner}/{repo} with the owner's installation token (or the
 * PAT) and maps `permissions.pull` -> read, `permissions.push` -> write. A
 * failure becomes read:false, write:false plus a fixed error class
 * (not_found | forbidden | rate_limited | network).
 *
 * Gating lives here, not in the caller: run() does nothing (zero fetch calls)
 * unless the feature flag is on, and then probes at most once per interval or
 * when the repo scope changed. Concurrency is capped at 3. The token is passed
 * only in the Authorization header — never logged, never in the result.
 * Everything is injected so it is deterministically testable.
 */

import type { Clock } from "./clock.ts";

export const REPO_ACCESS_INTERVAL_MS = 30 * 60 * 1000;
const REPO_ACCESS_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export type RepoAccessErrorClass =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "network";

export interface RepoAccessEntry {
  repo: string;
  owner: string;
  read: boolean;
  write: boolean;
  checkedAt: string;
  error?: RepoAccessErrorClass;
}

export interface RepoAccessProbeDeps {
  fetch: typeof fetch;
  clock: Clock;
  /** Token for the owner's installation, the PAT, or null when there is none. */
  tokenFor(owner: string): Promise<string | null>;
  log(message: string): void;
  /** Scoped repos as `org/repo` strings. */
  getRepos(): string[];
  isEnabled(): boolean;
  intervalMs?: number;
}

export interface RepoAccessProbe {
  /**
   * Returns a fresh result when a probe round ran, or undefined when it did
   * not (feature off, or not due and the scope is unchanged).
   */
  run(): Promise<RepoAccessEntry[] | undefined>;
}

function classify(res: Response): RepoAccessErrorClass {
  if (res.status === 404) return "not_found";
  if (res.status === 429) return "rate_limited";
  if (res.status === 403) {
    return res.headers.get("x-ratelimit-remaining") === "0"
      ? "rate_limited"
      : "forbidden";
  }
  if (res.status === 401) return "forbidden";
  return "network";
}

function failed(
  owner: string,
  repo: string,
  checkedAt: string,
  error: RepoAccessErrorClass,
): RepoAccessEntry {
  return { repo, owner, read: false, write: false, checkedAt, error };
}

export function createRepoAccessProbe(
  deps: RepoAccessProbeDeps,
): RepoAccessProbe {
  const intervalMs = deps.intervalMs ?? REPO_ACCESS_INTERVAL_MS;
  let lastScope: string | null = null;
  let lastRunAt = 0;
  let running = false;

  async function probeOne(slug: string): Promise<RepoAccessEntry> {
    const [owner = "", repo = ""] = slug.split("/");
    const checkedAt = deps.clock.now().toISOString();
    try {
      const token = await deps.tokenFor(owner);
      if (!token) return failed(owner, repo, checkedAt, "forbidden");
      const res = await deps.fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) return failed(owner, repo, checkedAt, classify(res));
      const body = (await res.json()) as {
        permissions?: { pull?: boolean; push?: boolean };
      };
      return {
        repo,
        owner,
        read: body.permissions?.pull === true,
        write: body.permissions?.push === true,
        checkedAt,
      };
    } catch {
      // Never interpolate the error: a thrown message could carry request detail.
      return failed(owner, repo, checkedAt, "network");
    }
  }

  async function probeAll(slugs: string[]): Promise<RepoAccessEntry[]> {
    const results: RepoAccessEntry[] = new Array(slugs.length);
    let next = 0;
    const worker = async () => {
      while (next < slugs.length) {
        const i = next++;
        results[i] = await probeOne(slugs[i] as string);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(REPO_ACCESS_CONCURRENCY, slugs.length) },
        worker,
      ),
    );
    return results;
  }

  return {
    async run() {
      if (!deps.isEnabled() || running) return undefined;
      const slugs = [...new Set(deps.getRepos())]
        .filter((r) => r.includes("/"))
        .sort();
      const scope = slugs.join(",");
      const nowMs = deps.clock.now().getTime();
      const scopeChanged = scope !== lastScope;
      if (!scopeChanged && nowMs - lastRunAt < intervalMs) return undefined;
      running = true;
      lastScope = scope;
      lastRunAt = nowMs;
      try {
        const results = await probeAll(slugs);
        deps.log(
          `[repo-access] probed ${results.length} repo(s), ${results.filter((r) => r.error).length} with errors`,
        );
        return results;
      } finally {
        running = false;
      }
    },
  };
}

interface InstallationTokenSource {
  getState?(): {
    installations: { id: number; owner: string | null; health: string }[];
  };
  /** Present on the real manager; the ref's narrower type omits it. */
  getToken?(installationId: number): Promise<string>;
}

/**
 * Builds `tokenFor`: the healthy installation whose owner matches (case
 * insensitive), else the PAT from GH_TOKEN, else null. The manager is read
 * lazily because App auth may activate after boot.
 */
export function createRepoAccessTokenFor(
  getManager: () => InstallationTokenSource | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): (owner: string) => Promise<string | null> {
  return async (owner) => {
    const manager = getManager();
    const match = manager
      ?.getState?.()
      .installations.find(
        (i) =>
          i.owner?.toLowerCase() === owner.toLowerCase() &&
          i.health !== "broken",
      );
    if (manager?.getToken && match) return manager.getToken(match.id);
    return env.GH_TOKEN || null;
  };
}
