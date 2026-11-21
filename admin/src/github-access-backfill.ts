/**
 * admin/src/github-access-backfill.ts
 * Backfill of per-user repo access into the access table (GLC-1.3).
 *
 * Rows are keyed (account, org, repo, username), so agents that share a GitHub
 * user share rows: users are deduplicated before any call is made.
 *
 * Work list per user: repos with no usable answer ("missing": no row, or an
 * error row whose nextAttemptAt has passed) come before repos whose ok row is
 * older than maxAgeMs ("expired"). Within each group the agent's configured
 * repos come first. Terminal rows and error rows still backing off are skipped.
 *
 * Only a definitive answer is stored as an access answer (status ok): a role,
 * including "none", or a 404 (user or repo not visible to the user, which
 * means no access). A timeout, 5xx, 403, unknown role or any other failure
 * stores no answer: the row becomes status error with attempts + 1 and a
 * capped-backoff nextAttemptAt, and once attempts reaches maxAttempts it
 * becomes terminal (never retried, never counted as missing). A rate limit
 * writes no row at all; it records rateLimitResetAt on the snapshot and ends
 * the run, and later runs before that time make no calls.
 */

import type { Clock } from "./clock.ts";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  GithubLookupRateLimitError,
  type LookupRateLimit,
  rateLimitResetAt,
  type RepoRole,
} from "./github-lookup-client.ts";
import type {
  AccessInput,
  SnapshotKey,
  SnapshotProgress,
} from "./github-repo-cache.ts";
import { canPushForRole } from "./user-repo-access-resolver.ts";

/** Port: one per-repo permission check (GithubLookupClient satisfies it). */
export interface AccessProbe {
  getCollaboratorPermissionWithRateLimit(
    owner: string,
    repo: string,
    username: string,
  ): Promise<{ role: RepoRole; rateLimit: LookupRateLimit }>;
}

export interface AccessRow {
  repo: string;
  status: string;
  checkedAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
}

/** Port: GitHubRepoCacheService satisfies it. */
export interface AccessBackfillStore {
  getAccessRows(query: {
    accountId: string;
    org: string;
    username: string;
    repos: string[];
  }): Promise<AccessRow[]>;
  upsertAccess(input: AccessInput): Promise<unknown>;
  getSnapshot(
    key: SnapshotKey,
  ): Promise<{ rateLimitResetAt: Date | null } | null>;
  upsertSnapshot(
    key: SnapshotKey,
    progress?: SnapshotProgress,
  ): Promise<unknown>;
}

export interface BackfillUser {
  /** GitHub login; compared case-insensitively. */
  username: string;
  /** Repo names (without org) the agent(s) bound to this user are set up for. */
  configuredRepos?: string[];
}

export interface BackfillOptions {
  accountId: string;
  org: string;
  /** Snapshot that carries rateLimitResetAt (the org's lookup snapshot). */
  snapshotKey: SnapshotKey;
  /** Repo names (without org) in the org's repo cache. */
  repos: string[];
  users: BackfillUser[];
  probe: AccessProbe;
  store: AccessBackfillStore;
  clock: Clock;
  /** An ok row older than this is expired. */
  maxAgeMs: number;
  /** Failures before a pair becomes terminal. Default 5. */
  maxAttempts?: number;
  /** Delay before retrying after the n-th failure; default capped exponential. */
  backoffMs?: (attempts: number) => number;
  /** Stop when X-RateLimit-Remaining falls to this or below. Default 10. */
  lowRemaining?: number;
  /** Most probes in this run. Default 500. */
  maxProbes?: number;
  /**
   * Checked before every probe after the first; true ends the run as
   * in_progress. Lets a caller bound a run by time.
   */
  shouldStop?: () => boolean;
}

export type BackfillOutcome = "complete" | "in_progress" | "rate_limited";

export interface BackfillResult {
  outcome: BackfillOutcome;
  /** Permission calls made this run. */
  probed: number;
  recorded: number;
  failed: number;
  terminal: number;
  /** Pairs with no ok answer that are not terminal (blocks completion). */
  missing: number;
  rateLimitResetAt?: Date;
}

export interface WorkItem {
  username: string;
  repo: string;
  kind: "missing" | "expired";
}

const MAX_ERROR_LENGTH = 500;
export const DEFAULT_ACCESS_MAX_ATTEMPTS = 5;

/** 1m, 2m, 4m, ... capped at 1h. */
export function defaultAccessBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/**
 * Order the pairs still needing a check for one user: missing before expired,
 * configured repos first within each. `rows` are the user's existing rows.
 * Also returns how many pairs have no ok answer and are not terminal.
 */
export function buildWorkList(args: {
  username: string;
  repos: string[];
  configuredRepos: string[];
  rows: AccessRow[];
  now: Date;
  maxAgeMs: number;
}): { work: WorkItem[]; unanswered: number } {
  const byRepo = new Map(args.rows.map((r) => [r.repo, r]));
  const configured = new Set(args.configuredRepos);
  const staleBefore = args.now.getTime() - args.maxAgeMs;
  const items: (WorkItem & { index: number })[] = [];
  let unanswered = 0;
  args.repos.forEach((repo, index) => {
    const row = byRepo.get(repo);
    if (row?.status === "terminal") return;
    if (row?.status === "ok") {
      if (row.checkedAt.getTime() < staleBefore) {
        items.push({ username: args.username, repo, kind: "expired", index });
      }
      return;
    }
    unanswered++;
    const backingOff =
      row?.status === "error" &&
      row.nextAttemptAt !== null &&
      row.nextAttemptAt > args.now;
    if (!backingOff) {
      items.push({ username: args.username, repo, kind: "missing", index });
    }
  });
  items.sort(
    (a, b) =>
      Number(a.kind === "expired") - Number(b.kind === "expired") ||
      Number(!configured.has(a.repo)) - Number(!configured.has(b.repo)) ||
      a.index - b.index,
  );
  return {
    work: items.map(({ index: _i, ...item }) => item),
    unanswered,
  };
}

export async function backfillAccess(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const { store, clock, probe } = opts;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_ACCESS_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? defaultAccessBackoffMs;
  const lowRemaining = opts.lowRemaining ?? 10;
  const maxProbes = opts.maxProbes ?? 500;
  const result: BackfillResult = {
    outcome: "complete",
    probed: 0,
    recorded: 0,
    failed: 0,
    terminal: 0,
    missing: 0,
  };

  // Agents sharing a user share rows: merge by lower-cased login.
  const users = new Map<string, Set<string>>();
  for (const u of opts.users) {
    const name = u.username.trim().toLowerCase();
    if (!name) continue;
    const set = users.get(name) ?? new Set<string>();
    for (const r of u.configuredRepos ?? []) set.add(r);
    users.set(name, set);
  }

  const snap = await store.getSnapshot(opts.snapshotKey);
  const gate = snap?.rateLimitResetAt ?? null;
  if (gate && gate.getTime() > clock.now().getTime()) {
    result.outcome = "rate_limited";
    result.rateLimitResetAt = gate;
    result.missing = await countMissing();
    return result;
  }

  const rowsByKey = new Map<string, AccessRow>();
  const work: WorkItem[] = [];
  for (const [username, configured] of users) {
    const rows = await store.getAccessRows({
      accountId: opts.accountId,
      org: opts.org,
      username,
      repos: opts.repos,
    });
    for (const r of rows) rowsByKey.set(`${username}/${r.repo}`, r);
    const list = buildWorkList({
      username,
      repos: opts.repos,
      configuredRepos: [...configured],
      rows,
      now: clock.now(),
      maxAgeMs: opts.maxAgeMs,
    });
    result.missing += list.unanswered;
    work.push(...list.work);
  }
  // All missing pairs before any expired one; each user's list is already
  // configured-first and Array.sort is stable.
  const queue = work.sort(
    (a, b) => Number(a.kind === "expired") - Number(b.kind === "expired"),
  );

  for (const item of queue) {
    if (
      result.probed >= maxProbes ||
      (result.probed > 0 && opts.shouldStop?.())
    ) {
      result.outcome = "in_progress";
      return result;
    }
    const key = `${item.username}/${item.repo}`;
    result.probed++;
    try {
      const { role, rateLimit } =
        await probe.getCollaboratorPermissionWithRateLimit(
          opts.org,
          item.repo,
          item.username,
        );
      await record(item, role);
      if (item.kind === "missing") result.missing--;
      if (rateLimit.remaining !== null && rateLimit.remaining <= lowRemaining) {
        return await stopForRateLimit(rateLimit);
      }
    } catch (err) {
      if (err instanceof GithubEnterpriseError && err.kind === "rate_limit") {
        return await stopForRateLimit({
          remaining: 0,
          resetAt:
            err instanceof GithubLookupRateLimitError ? err.resetAt : null,
          retryAfterSeconds: err.retryAfterSeconds ?? null,
        });
      }
      if (err instanceof GithubEnterpriseError && err.kind === "not_found") {
        await record(item, "none");
        if (item.kind === "missing") result.missing--;
        continue;
      }
      await fail(item, key, err);
    }
  }
  result.outcome = result.missing === 0 ? "complete" : "in_progress";
  return result;

  async function record(item: WorkItem, role: RepoRole) {
    await store.upsertAccess({
      accountId: opts.accountId,
      org: opts.org,
      repo: item.repo,
      username: item.username,
      canPush: canPushForRole(role),
      level: role,
      status: "ok",
    });
    result.recorded++;
  }

  async function fail(item: WorkItem, key: string, err: unknown) {
    const prev = rowsByKey.get(key);
    // An expired ok row's attempts do not count toward the cap.
    const n = (prev?.status === "error" ? prev.attempts : 0) + 1;
    const now = clock.now();
    const terminal = n >= maxAttempts;
    const lastError = (err instanceof Error ? err.message : String(err)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    await store.upsertAccess({
      accountId: opts.accountId,
      org: opts.org,
      repo: item.repo,
      username: item.username,
      canPush: false,
      level: null,
      status: terminal ? "terminal" : "error",
      attempts: n,
      nextAttemptAt: terminal ? null : new Date(now.getTime() + backoffMs(n)),
      lastError,
    });
    result.failed++;
    if (terminal) {
      result.terminal++;
      if (item.kind === "missing" || prev?.status === "error") result.missing--;
    } else if (item.kind === "expired") {
      // The old ok answer was overwritten by an error row: now unanswered.
      result.missing++;
    }
  }

  async function stopForRateLimit(
    rl: LookupRateLimit,
  ): Promise<BackfillResult> {
    const at = rateLimitResetAt(rl, clock.now());
    await store.upsertSnapshot(opts.snapshotKey, { rateLimitResetAt: at });
    result.outcome = "rate_limited";
    result.rateLimitResetAt = at;
    return result;
  }

  async function countMissing(): Promise<number> {
    let n = 0;
    for (const [username, configured] of users) {
      const rows = await store.getAccessRows({
        accountId: opts.accountId,
        org: opts.org,
        username,
        repos: opts.repos,
      });
      n += buildWorkList({
        username,
        repos: opts.repos,
        configuredRepos: [...configured],
        rows,
        now: clock.now(),
        maxAgeMs: opts.maxAgeMs,
      }).unanswered;
    }
    return n;
  }
}
