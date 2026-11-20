/**
 * admin/src/github-repo-refresher.ts
 * GithubRepoRefresher (GLC-1.4): the background tick that keeps the GitHub
 * repo/access cache current. Registered via setInterval in admin-boot.ts
 * (never inside an app factory), like the other sweepers.
 *
 * A target is one cache snapshot: the lookup App's repos on an org (plus the
 * access pairs of the agents bound to GitHub users), or one agent App's
 * installation repos on an org. Each snapshot row carries its own lease,
 * rateLimitResetAt and debug columns (GLC-1.1), so "per org" here means per
 * snapshot row.
 *
 * Every tick:
 * - Is a no-op while a previous tick in this process is still running.
 * - Discovers targets (cached for discoveryIntervalMs).
 * - Skips targets inside their rate-limit window (rateLimitResetAt is the
 *   resume time) and targets with nothing to do; works the rest with missing
 *   work first, least recently ticked first within a rank.
 * - Per target: takes the snapshot lease (first worker wins; a held lease
 *   means skip), then runs steps chosen by planOrgWork, re-planning after
 *   each step from fresh state, and releases the lease.
 * - Stops starting new targets or steps once the time budget is spent, and
 *   hands every crawl/backfill a shouldStop that turns true at the deadline.
 * - Catches every per-target failure: one org failing never blocks another.
 *
 * Priority within a target (planOrgWork): forced refreshes past the
 * staleness cap, then missing work (never-crawled or incomplete list, access
 * pairs with no answer), then expired work (TTL passed) only when nothing is
 * missing. The cap guarantees an expired refresh is never starved by a long
 * backfill.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type Clock, SystemClock } from "./clock.ts";
import {
  type AccessBackfillStore,
  type AccessProbe,
  type BackfillUser,
  backfillAccess,
  buildWorkList,
} from "./github-access-backfill.ts";
import type { SnapshotKey, SnapshotProgress } from "./github-repo-cache.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RefreshConfig {
  /** How often a tick starts. */
  intervalMs: number;
  /** A completed list or ok access answer older than this is expired. */
  ttlMs: number;
  /** Expired data older than this is refreshed even while missing work is pending. Never below ttlMs. */
  stalenessCapMs: number;
  /** A tick starts no new target or step after this long. */
  timeBudgetMs: number;
}

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_REFRESH_TTL_MS = 3_600_000;
export const DEFAULT_REFRESH_STALENESS_CAP_MS = 6 * 3_600_000;
export const DEFAULT_REFRESH_TIME_BUDGET_MS = 45_000;
/** How long discovered targets are reused before discovery runs again. */
export const DEFAULT_REFRESH_DISCOVERY_INTERVAL_MS = 10 * 60_000;

function positiveMs(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the refresher config. Unset, blank, non-numeric and non-positive values
 * fall back to the defaults; a staleness cap below the TTL is raised to it.
 */
export function resolveRefreshConfig(
  env: Record<string, string | undefined>,
): RefreshConfig {
  const ttlMs = positiveMs(
    env.SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TTL_MS,
    DEFAULT_REFRESH_TTL_MS,
  );
  return {
    intervalMs: positiveMs(
      env.SHIPWRIGHT_ADMIN_GITHUB_REFRESH_INTERVAL_MS,
      DEFAULT_REFRESH_INTERVAL_MS,
    ),
    ttlMs,
    stalenessCapMs: Math.max(
      ttlMs,
      positiveMs(
        env.SHIPWRIGHT_ADMIN_GITHUB_REFRESH_STALENESS_CAP_MS,
        DEFAULT_REFRESH_STALENESS_CAP_MS,
      ),
    ),
    timeBudgetMs: positiveMs(
      env.SHIPWRIGHT_ADMIN_GITHUB_REFRESH_TIME_BUDGET_MS,
      DEFAULT_REFRESH_TIME_BUDGET_MS,
    ),
  };
}

// ─── Ports ───────────────────────────────────────────────────────────────────

/** The snapshot fields the refresher reads. */
export interface RefreshSnapshot {
  id: string;
  completedAt: Date | null;
  crawlStartedAt: Date | null;
  nextAttemptAt: Date | null;
  rateLimitResetAt: Date | null;
  lastTickAt: Date | null;
  lastError: string | null;
}

/** Port: GitHubRepoCacheService satisfies it. */
export interface RefreshStore extends AccessBackfillStore {
  getSnapshot(key: SnapshotKey): Promise<RefreshSnapshot | null>;
  upsertSnapshot(
    key: SnapshotKey,
    progress?: SnapshotProgress,
  ): Promise<RefreshSnapshot>;
  acquireLease(
    snapshotId: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLease(snapshotId: string, holder: string): Promise<void>;
  listRepoFullNames(snapshotId: string): Promise<string[]>;
}

/** What a crawl or backfill step reported. */
export interface StepOutcome {
  outcome: string;
  rateLimitResetAt?: Date;
  error?: string;
}

/** One snapshot to keep current. */
export interface RefreshTarget {
  key: SnapshotKey;
  /** One resumable crawl run of this snapshot's repo list. */
  crawl(ctx: { shouldStop: () => boolean }): Promise<StepOutcome>;
  /** Present on lookup targets with GitHub-user-bound agents. */
  access?: { probe: AccessProbe; users: BackfillUser[] };
}

export interface RefreshDiscovery {
  listTargets(): Promise<RefreshTarget[]>;
}

// ─── Planning ────────────────────────────────────────────────────────────────

export type RefreshReason = "missing" | "expired" | "stale_cap";

export type RefreshStep =
  | { kind: "crawl"; reason: RefreshReason }
  /** repos: restrict the backfill to these (stale_cap only). */
  | { kind: "access"; reason: RefreshReason; repos?: string[] };

export interface AccessSummary {
  /** Pairs with no answer that can be checked now. */
  missing: number;
  /** Ok answers older than the TTL. */
  expired: number;
  /** Repo names with an ok answer older than the staleness cap. */
  staleRepos: string[];
}

/**
 * The steps for one target, in order. A crawl still backing off
 * (nextAttemptAt in the future) is not runnable, so it neither runs nor holds
 * expired work back; the same holds for access pairs backing off.
 */
export function planOrgWork(args: {
  snapshot: RefreshSnapshot;
  access?: AccessSummary;
  now: Date;
  ttlMs: number;
  stalenessCapMs: number;
}): RefreshStep[] {
  const { snapshot: s, access, now } = args;
  const t = now.getTime();
  const crawlRunnable = !s.nextAttemptAt || s.nextAttemptAt.getTime() <= t;
  const done = s.completedAt?.getTime();
  const crawlMissing = crawlRunnable && done === undefined;
  const crawlExpired =
    crawlRunnable && done !== undefined && done <= t - args.ttlMs;
  const crawlCapped =
    crawlRunnable && done !== undefined && done <= t - args.stalenessCapMs;
  const accessMissing = (access?.missing ?? 0) > 0;
  const anyMissing = crawlMissing || accessMissing;

  const steps: RefreshStep[] = [];
  if (anyMissing) {
    if (crawlCapped) steps.push({ kind: "crawl", reason: "stale_cap" });
    if (access && access.staleRepos.length > 0) {
      steps.push({
        kind: "access",
        reason: "stale_cap",
        repos: access.staleRepos,
      });
    }
    if (crawlMissing) steps.push({ kind: "crawl", reason: "missing" });
    if (accessMissing) steps.push({ kind: "access", reason: "missing" });
  } else {
    if (crawlExpired) steps.push({ kind: "crawl", reason: "expired" });
    if ((access?.expired ?? 0) > 0) {
      steps.push({ kind: "access", reason: "expired" });
    }
  }
  return steps;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type RefreshTargetState =
  /** Nothing to do this tick. */
  | "idle"
  /** At least one step ran. */
  | "worked"
  /** Inside the rate-limit window; resumeAt says when to try again. */
  | "rate_limited"
  /** Another worker holds the lease. */
  | "leased_elsewhere"
  /** The time budget ran out before this target was started. */
  | "deferred"
  | "error";

export interface RefreshTargetStatus {
  key: SnapshotKey;
  state: RefreshTargetState;
  /** Steps run this tick, as kind:reason. */
  steps: string[];
  /** Outcome of the last step run. */
  outcome?: string;
  error?: string;
  resumeAt?: Date;
  at: Date;
}

export interface RefreshTickResult {
  skipped?: "overlap";
  /** Discovery failure, if any (previously discovered targets are reused). */
  error?: string;
  targets: RefreshTargetStatus[];
}

export interface RefreshStatus {
  running: boolean;
  /** Start of the last tick that ran. */
  lastTickAt: Date | null;
  lastTickDurationMs: number | null;
  /** Latest status per target, keyed by snapshotKeyString. */
  targets: Record<string, RefreshTargetStatus>;
}

export function snapshotKeyString(key: SnapshotKey): string {
  return `${key.accountId}|${key.appKind}|${key.appRef}|${key.org}`;
}

// ─── Refresher ───────────────────────────────────────────────────────────────

export interface GithubRepoRefresherDeps {
  discovery: RefreshDiscovery;
  store: RefreshStore;
  config: RefreshConfig;
  clock?: Clock;
  /** Lease holder id; default host:pid:random. */
  holder?: string;
  discoveryIntervalMs?: number;
  log?: (line: string) => void;
}

/** Access-step maxAgeMs that treats no answer as expired (missing work only). */
const NEVER_EXPIRES_MS = Number.MAX_SAFE_INTEGER;
/** Slack on top of the time budget for one in-flight request to finish. */
const LEASE_SLACK_MS = 120_000;
const MAX_STEPS_PER_TARGET = 8;

interface Planned {
  target: RefreshTarget;
  snapshot: RefreshSnapshot;
  steps: RefreshStep[];
}

export class GithubRepoRefresher {
  private readonly clock: Clock;
  private readonly holder: string;
  private readonly log: (line: string) => void;
  private readonly discoveryIntervalMs: number;
  private running = false;
  private cachedTargets: RefreshTarget[] = [];
  private discoveredAt: number | null = null;
  private readonly state: RefreshStatus = {
    running: false,
    lastTickAt: null,
    lastTickDurationMs: null,
    targets: {},
  };

  constructor(private readonly deps: GithubRepoRefresherDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.holder =
      deps.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.log = deps.log ?? ((line) => console.log(line));
    this.discoveryIntervalMs =
      deps.discoveryIntervalMs ?? DEFAULT_REFRESH_DISCOVERY_INTERVAL_MS;
  }

  /** Debug snapshot of the last ticks (a copy). */
  status(): RefreshStatus {
    return {
      ...this.state,
      running: this.running,
      targets: { ...this.state.targets },
    };
  }

  /** One tick. Never throws; a tick while one is running is a no-op. */
  async tick(): Promise<RefreshTickResult> {
    if (this.running) return { skipped: "overlap", targets: [] };
    this.running = true;
    const started = this.clock.now();
    this.state.lastTickAt = started;
    try {
      return await this.run(started);
    } catch (err) {
      // Defensive: run() catches per target; this covers the planning reads.
      const error = messageOf(err);
      console.error("[github-repo-refresher] tick failed:", error);
      return { error, targets: [] };
    } finally {
      this.state.lastTickDurationMs =
        this.clock.now().getTime() - started.getTime();
      this.running = false;
    }
  }

  private async run(started: Date): Promise<RefreshTickResult> {
    const { config } = this.deps;
    const deadline = started.getTime() + config.timeBudgetMs;
    const shouldStop = () => this.clock.now().getTime() >= deadline;
    const result: RefreshTickResult = { targets: [] };

    let targets: RefreshTarget[];
    try {
      targets = await this.discover(started);
    } catch (err) {
      result.error = messageOf(err);
      console.error("[github-repo-refresher] discovery failed:", result.error);
      targets = this.cachedTargets;
    }

    const planned: Planned[] = [];
    for (const target of targets) {
      try {
        const p = await this.plan(target);
        const resetAt = p.snapshot.rateLimitResetAt;
        if (resetAt && resetAt.getTime() > this.clock.now().getTime()) {
          this.record(result, target, {
            state: "rate_limited",
            resumeAt: resetAt,
          });
        } else if (p.steps.length === 0) {
          this.record(result, target, { state: "idle" });
        } else {
          planned.push(p);
        }
      } catch (err) {
        this.record(result, target, { state: "error", error: messageOf(err) });
      }
    }

    planned.sort(
      (a, b) =>
        rank(a.steps) - rank(b.steps) ||
        (a.snapshot.lastTickAt?.getTime() ?? 0) -
          (b.snapshot.lastTickAt?.getTime() ?? 0),
    );

    let worked = 0;
    for (const p of planned) {
      if (shouldStop()) {
        this.record(result, p.target, { state: "deferred" });
        continue;
      }
      const status = await this.work(p, shouldStop);
      if (status.state === "worked") worked++;
      this.record(result, p.target, status);
    }

    if (worked > 0 || result.error) {
      this.log(
        `[github-repo-refresher] targets=${targets.length} worked=${worked} ms=${this.clock.now().getTime() - started.getTime()}`,
      );
    }
    return result;
  }

  private async discover(now: Date): Promise<RefreshTarget[]> {
    if (
      this.discoveredAt !== null &&
      now.getTime() - this.discoveredAt < this.discoveryIntervalMs
    ) {
      return this.cachedTargets;
    }
    const targets = await this.deps.discovery.listTargets();
    this.cachedTargets = targets;
    this.discoveredAt = now.getTime();
    return targets;
  }

  /** Read fresh state for a target and plan its steps. */
  private async plan(target: RefreshTarget): Promise<Planned> {
    const { store, config } = this.deps;
    const snapshot =
      (await store.getSnapshot(target.key)) ??
      (await store.upsertSnapshot(target.key));
    const now = this.clock.now();
    const access = target.access
      ? await this.summarizeAccess(target, snapshot.id, now)
      : undefined;
    const steps = planOrgWork({
      snapshot,
      ...(access ? { access } : {}),
      now,
      ttlMs: config.ttlMs,
      stalenessCapMs: config.stalenessCapMs,
    });
    return { target, snapshot, steps };
  }

  private async repoNames(target: RefreshTarget, snapshotId: string) {
    const prefix = `${target.key.org.toLowerCase()}/`;
    return (await this.deps.store.listRepoFullNames(snapshotId))
      .filter((n) => n.toLowerCase().startsWith(prefix))
      .map((n) => n.slice(prefix.length));
  }

  private async summarizeAccess(
    target: RefreshTarget,
    snapshotId: string,
    now: Date,
  ): Promise<AccessSummary> {
    const { store, config } = this.deps;
    const repos = await this.repoNames(target, snapshotId);
    const summary: AccessSummary = { missing: 0, expired: 0, staleRepos: [] };
    if (repos.length === 0) return summary;
    const stale = new Set<string>();
    for (const [username, configured] of mergeUsers(
      target.access?.users ?? [],
    )) {
      const rows = await store.getAccessRows({
        accountId: target.key.accountId,
        org: target.key.org,
        username,
        repos,
      });
      const base = { username, repos, configuredRepos: configured, rows, now };
      for (const item of buildWorkList({ ...base, maxAgeMs: config.ttlMs })
        .work) {
        if (item.kind === "missing") summary.missing++;
        else summary.expired++;
      }
      for (const item of buildWorkList({
        ...base,
        maxAgeMs: config.stalenessCapMs,
      }).work) {
        if (item.kind === "expired") stale.add(item.repo);
      }
    }
    summary.staleRepos = repos.filter((r) => stale.has(r));
    return summary;
  }

  /** Lease, run steps (re-planning after each), release. Never throws. */
  private async work(
    p: Planned,
    shouldStop: () => boolean,
  ): Promise<Omit<RefreshTargetStatus, "key" | "at">> {
    const { store, config } = this.deps;
    const { target } = p;
    const leaseMs = config.timeBudgetMs + LEASE_SLACK_MS;
    let leased = false;
    const steps: string[] = [];
    let outcome: string | undefined;
    try {
      leased = await store.acquireLease(p.snapshot.id, this.holder, leaseMs);
      if (!leased) return { state: "leased_elsewhere", steps };
      const done = new Set<string>();
      for (let i = 0; i < MAX_STEPS_PER_TARGET; i++) {
        // Fresh state every time: another worker may have run before we took
        // the lease, and each step changes what is missing.
        const next = await this.plan(target);
        const step = next.steps.find((s) => !done.has(stepName(s)));
        if (!step || (i > 0 && shouldStop())) break;
        done.add(stepName(step));
        steps.push(stepName(step));
        const out = await this.runStep(target, next.snapshot.id, step, {
          shouldStop,
        });
        outcome = out.outcome;
        if (out.outcome === "rate_limited") {
          return {
            state: "rate_limited",
            steps,
            outcome,
            ...(out.rateLimitResetAt ? { resumeAt: out.rateLimitResetAt } : {}),
          };
        }
      }
      // No steps: another worker finished the work before we took the lease.
      return {
        state: steps.length > 0 ? "worked" : "idle",
        steps,
        ...(outcome === undefined ? {} : { outcome }),
      };
    } catch (err) {
      return {
        state: "error",
        steps,
        error: messageOf(err),
        ...(outcome === undefined ? {} : { outcome }),
      };
    } finally {
      if (leased) {
        try {
          await store.upsertSnapshot(target.key, {
            lastTickAt: this.clock.now(),
          });
        } catch (err) {
          console.error(
            "[github-repo-refresher] lastTickAt write failed:",
            messageOf(err),
          );
        }
        try {
          await store.releaseLease(p.snapshot.id, this.holder);
        } catch (err) {
          // The lease expires on its own.
          console.error(
            "[github-repo-refresher] lease release failed:",
            messageOf(err),
          );
        }
      }
    }
  }

  private async runStep(
    target: RefreshTarget,
    snapshotId: string,
    step: RefreshStep,
    ctx: { shouldStop: () => boolean },
  ): Promise<StepOutcome> {
    if (step.kind === "crawl") return target.crawl(ctx);
    const access = target.access;
    if (!access) return { outcome: "complete" };
    const { config, store } = this.deps;
    const maxAgeMs =
      step.reason === "missing"
        ? NEVER_EXPIRES_MS
        : step.reason === "expired"
          ? config.ttlMs
          : config.stalenessCapMs;
    const res = await backfillAccess({
      accountId: target.key.accountId,
      org: target.key.org,
      snapshotKey: target.key,
      repos: step.repos ?? (await this.repoNames(target, snapshotId)),
      users: access.users,
      probe: access.probe,
      store,
      clock: this.clock,
      maxAgeMs,
      shouldStop: ctx.shouldStop,
    });
    return {
      outcome: res.outcome,
      ...(res.rateLimitResetAt
        ? { rateLimitResetAt: res.rateLimitResetAt }
        : {}),
    };
  }

  private record(
    result: RefreshTickResult,
    target: RefreshTarget,
    status: Partial<Omit<RefreshTargetStatus, "key" | "at">> & {
      state: RefreshTargetState;
    },
  ): void {
    const full: RefreshTargetStatus = {
      steps: [],
      ...status,
      key: target.key,
      at: this.clock.now(),
    };
    result.targets.push(full);
    this.state.targets[snapshotKeyString(target.key)] = full;
  }
}

function stepName(s: RefreshStep): string {
  return `${s.kind}:${s.reason}`;
}

/** 0: forced or missing work; 1: expired only. */
function rank(steps: RefreshStep[]): number {
  return steps.some((s) => s.reason !== "expired") ? 0 : 1;
}

/** Same merge as backfillAccess: lower-cased login, configured repos unioned. */
function mergeUsers(users: BackfillUser[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const u of users) {
    const name = u.username.trim().toLowerCase();
    if (!name) continue;
    const set = out.get(name) ?? new Set<string>();
    for (const r of u.configuredRepos ?? []) set.add(r);
    out.set(name, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
