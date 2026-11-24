/**
 * admin/src/installation-repos-service.ts
 * Read-only listing of the repos on an agent's own GitHub App installation
 * (IRM-1.2), with the bound user's push hint. list() reads only the repo/access
 * cache (GLC-2.2): no GitHub call, sync detail alongside. Changes go through
 * the Sync flow (github-sync.ts, IRM-3.1), which still uses the installer App
 * through the installation port.
 */

import {
  GITHUB_APPS_STATE_REASONS,
  type GithubAppsState,
  type GithubAppsStateFn,
} from "./github-apps-state.ts";
import type { GithubAccessPreviewFn } from "./github-access-preview.ts";
import { DEPLOYMENT_WIDE_ACCOUNT_KEY } from "./github-agent-installation-crawler.ts";
import {
  type AppIdentity,
  type AppInstallationPort,
  AppNotInstalledError,
  type InstallationAgentsPort,
  MISSING_APP_ID_REASON,
} from "./installation-ports.ts";
import type {
  OrgAccessResult,
  UserRepoAccessResult,
} from "./user-repo-access-resolver.ts";

/**
 * The orgs the agent App is installed on, or "none" when the App matched no
 * org the installer can reach (distinct from an installation with no changes).
 */
export type InstalledOrgsResult =
  | { status: "found"; orgs: { org: string; repos: string[] }[] }
  | { status: "none" };

/** Installation port plus discovery of the orgs the agent App is installed on. */
export interface InstallationReposPort extends AppInstallationPort {
  listInstalled(
    appId: number,
    identity?: AppIdentity,
  ): Promise<InstalledOrgsResult>;
}

export const NO_INSTALLATION_REASON =
  "No installation of the agent GitHub App was found on any org the installer can reach (matched by client id or slug). Check the App installation and the agent GH_APP_CLIENT_ID / GH_APP_SLUG.";

export interface InstallationRepoView {
  fullName: string;
  /** Present only when the bound user's access to this repo is known. */
  userCanPush?: boolean;
  /** ISO time the bound user's access to this repo was last checked, when a row exists. */
  accessCheckedAt?: string;
  /** Failed access checks for this repo since the last success, when any. */
  accessAttempts?: number;
  /** Last access-check error for this repo, when any. */
  accessError?: string;
}

/** Sync detail for one org's cached snapshot (all optional, additive). */
export interface InstallationSyncDetail {
  /** True once the org's crawl completed. */
  complete?: boolean;
  /** ISO time of the completed crawl; absent until one completed. */
  syncedAt?: string;
  /** Repos in the cache for the org. */
  reposSeen?: number;
  /** GitHub's repo count for the org, when known ("N of M"). */
  totalCount?: number;
  lastError?: string;
  /** ISO time the GitHub rate limit resets, while limited. */
  rateLimitResetAt?: string;
  /** Failed refresh attempts since the last success. */
  attempts?: number;
  /** ISO time of the next refresh attempt, while backing off. */
  nextAttemptAt?: string;
  /** Holder of a live refresh lease. */
  leaseHolder?: string;
  /** ISO time of the last refresh tick on this snapshot. */
  lastTickAt?: string;
}

export interface InstallationOrgView extends InstallationSyncDetail {
  org: string;
  repos: InstallationRepoView[];
}

/** One cached agent-App snapshot with its repos (GitHubRepoCacheService.listAgentSnapshots). */
export interface InstallationSnapshotRow {
  org: string;
  completedAt: Date | null;
  totalCount: number | null;
  lastError: string | null;
  rateLimitResetAt: Date | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
  leaseHolder?: string | null;
  leasedUntil?: Date | null;
  lastTickAt?: Date | null;
  repos: { fullName: string }[];
}

/** A cached per-user access row (repo is the name without the org). */
export interface CachedAccessRow {
  repo: string;
  status: string;
  canPush: boolean;
  level?: string | null;
  checkedAt?: Date;
  attempts?: number;
  lastError?: string | null;
}

/** The slice of GitHubRepoCacheService the list reads; never calls GitHub. */
export interface InstallationCachePort {
  listAgentSnapshots(
    accountId: string,
    appRef: string,
  ): Promise<InstallationSnapshotRow[]>;
  getAccessRows(query: {
    accountId: string;
    org: string;
    username: string;
    repos: string[];
  }): Promise<CachedAccessRow[]>;
}

export type InstallationListResult =
  | { status: "agent_not_found" }
  | { status: "no_app_id"; reason: string }
  | { status: "skipped"; appId: number; reason: string }
  | ({
      status: "ok";
      appId: number;
      orgs: InstallationOrgView[];
      /** Set when an App role is missing; the listing is the cached crawl only (additive). */
      appsState?: Exclude<GithubAppsState, "both">;
      reason?: string;
    } & InstallationSyncDetail);

export interface InstallationReposDeps {
  agents: Pick<InstallationAgentsPort, "get">;
  /** Used by GitHub Sync, not by list(), which reads only the cache. */
  access: GithubAccessPreviewFn;
  installation: InstallationReposPort;
  /** The repo/access cache list() reads. Without it list() reports nothing synced. */
  cache?: InstallationCachePort;
  /** Optional: which Apps are usable; without both, list() says why (additive fields). */
  appsState?: GithubAppsStateFn;
}

/** The agent's App identity keys (client id, slug), when stored. */
export function identityOf(agent: {
  clientId?: string;
  slug?: string;
  accountId?: string | null;
}): AppIdentity {
  return {
    ...(agent.accountId ? { accountId: agent.accountId } : {}),
    ...(agent.clientId ? { clientId: agent.clientId } : {}),
    ...(agent.slug ? { slug: agent.slug } : {}),
  };
}

const orgKey = (org: string): string => org.toLowerCase();

/** Cached access rows for one org and user, as read from the access cache. */
export interface CachedAccessRows {
  cachedRows: readonly CachedAccessRow[];
}

/**
 * The user-can-push hint for one org: true/false per repo only when the bound
 * user is verified and this org's access data is complete (a live "ok" lookup
 * with nothing unresolved, or cached rows with an "ok" row for every listed
 * repo). Anything else is unknown, so it gets no hint (never false).
 */
export function userPushHints(
  access: UserRepoAccessResult | CachedAccessRows | undefined,
  org: string,
  repos: readonly string[],
): InstallationRepoView[] {
  const pushByName = new Map<string, boolean>();
  if (access && "cachedRows" in access) {
    const byRepo = new Map<string, CachedAccessRow>();
    for (const r of access.cachedRows) byRepo.set(r.repo.toLowerCase(), r);
    const nameOf = (fullName: string) =>
      fullName.slice(fullName.indexOf("/") + 1).toLowerCase();
    const complete = repos.every((f) => byRepo.get(nameOf(f))?.status === "ok");
    if (complete) {
      for (const f of repos) {
        pushByName.set(
          f.toLowerCase(),
          byRepo.get(nameOf(f))?.canPush ?? false,
        );
      }
    }
  } else {
    const orgResult: OrgAccessResult | undefined = access?.orgs.find(
      (o) => orgKey(o.org) === orgKey(org),
    );
    const complete =
      access !== undefined &&
      access.outcome === "ok" &&
      access.userVerified &&
      orgResult !== undefined &&
      orgResult.status === "ok" &&
      orgResult.unresolved === 0;
    if (complete) {
      for (const r of orgResult.repos) {
        pushByName.set(r.fullName.toLowerCase(), r.canPush);
      }
    }
  }
  return repos.map((fullName) => {
    const hint = pushByName.get(fullName.toLowerCase());
    return hint === undefined ? { fullName } : { fullName, userCanPush: hint };
  });
}

/** Adds per-repo checkedAt / attempts / last error from the cached rows (additive). */
function withAccessDetail(
  views: InstallationRepoView[],
  rows: readonly CachedAccessRow[],
): InstallationRepoView[] {
  const byRepo = new Map(rows.map((r) => [r.repo.toLowerCase(), r]));
  return views.map((v) => {
    const row = byRepo.get(
      v.fullName.slice(v.fullName.indexOf("/") + 1).toLowerCase(),
    );
    if (!row) return v;
    return {
      ...v,
      ...(row.checkedAt
        ? { accessCheckedAt: row.checkedAt.toISOString() }
        : {}),
      ...(row.attempts ? { accessAttempts: row.attempts } : {}),
      ...(row.lastError ? { accessError: row.lastError } : {}),
    };
  });
}

const iso = (d: Date | null): string | undefined =>
  d ? d.toISOString() : undefined;

/** Folds per-org sync detail into the page-level detail. */
function summarize(
  orgs: readonly InstallationOrgView[],
): InstallationSyncDetail {
  const complete = orgs.length > 0 && orgs.every((o) => o.complete === true);
  const synced = orgs
    .map((o) => o.syncedAt)
    .filter((d): d is string => d !== undefined)
    .sort();
  const totals = orgs.map((o) => o.totalCount);
  const totalCount = totals.every((t) => t !== undefined)
    ? totals.reduce<number>((a, t) => a + (t ?? 0), 0)
    : undefined;
  const lastError = orgs.find((o) => o.lastError)?.lastError;
  const reset = orgs
    .map((o) => o.rateLimitResetAt)
    .filter((d): d is string => d !== undefined)
    .sort()
    .at(-1);
  const attempts = Math.max(0, ...orgs.map((o) => o.attempts ?? 0));
  const next = orgs
    .map((o) => o.nextAttemptAt)
    .filter((d): d is string => d !== undefined)
    .sort()[0];
  const tick = orgs
    .map((o) => o.lastTickAt)
    .filter((d): d is string => d !== undefined)
    .sort()
    .at(-1);
  const holder = orgs.find((o) => o.leaseHolder)?.leaseHolder;
  return {
    complete,
    ...(attempts > 0 ? { attempts } : {}),
    ...(next ? { nextAttemptAt: next } : {}),
    ...(holder ? { leaseHolder: holder } : {}),
    ...(tick ? { lastTickAt: tick } : {}),
    reposSeen: orgs.reduce((a, o) => a + (o.reposSeen ?? 0), 0),
    ...(complete && synced[0] ? { syncedAt: synced[0] } : {}),
    ...(orgs.length > 0 && totalCount !== undefined ? { totalCount } : {}),
    ...(lastError ? { lastError } : {}),
    ...(reset ? { rateLimitResetAt: reset } : {}),
  };
}

export class InstallationReposService {
  constructor(private readonly deps: InstallationReposDeps) {}

  /**
   * Reads the agent-installation cache (crawled in the background) and the
   * cached access rows; it never calls GitHub. A hint appears only when the
   * org's snapshot is complete and every repo has an ok access row.
   */
  async list(agentId: string): Promise<InstallationListResult> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent) return { status: "agent_not_found" };
    if (agent.appId === undefined) {
      return { status: "no_app_id", reason: MISSING_APP_ID_REASON };
    }
    const cache = this.deps.cache;
    const accountId = agent.accountId || DEPLOYMENT_WIDE_ACCOUNT_KEY;
    const snapshots = cache
      ? await cache.listAgentSnapshots(accountId, String(agent.appId))
      : [];
    const username = agent.githubUsername?.trim();
    const orgs: InstallationOrgView[] = [];
    for (const s of snapshots) {
      const names = s.repos.map((r) => r.fullName);
      let repos: InstallationRepoView[] = names.map((fullName) => ({
        fullName,
      }));
      if (cache && username && s.completedAt && names.length > 0) {
        try {
          const rows = await cache.getAccessRows({
            accountId,
            org: s.org,
            username,
            repos: names.map((f) => f.slice(f.indexOf("/") + 1)),
          });
          repos = withAccessDetail(
            userPushHints({ cachedRows: rows }, s.org, names),
            rows,
          );
        } catch {
          // The hint is advisory: a failed cache read omits it.
        }
      }
      orgs.push({
        org: s.org,
        repos,
        complete: s.completedAt !== null,
        reposSeen: names.length,
        ...(s.completedAt ? { syncedAt: iso(s.completedAt) } : {}),
        ...(s.totalCount !== null ? { totalCount: s.totalCount } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(s.rateLimitResetAt
          ? { rateLimitResetAt: iso(s.rateLimitResetAt) }
          : {}),
        ...(s.attempts ? { attempts: s.attempts } : {}),
        ...(s.nextAttemptAt ? { nextAttemptAt: iso(s.nextAttemptAt) } : {}),
        ...(s.leaseHolder && s.leasedUntil && s.leasedUntil > new Date()
          ? { leaseHolder: s.leaseHolder }
          : {}),
        ...(s.lastTickAt ? { lastTickAt: iso(s.lastTickAt) } : {}),
      });
    }
    const state = this.deps.appsState
      ? await this.deps.appsState(agent.accountId)
      : "both";
    return {
      status: "ok",
      appId: agent.appId,
      orgs,
      ...summarize(orgs),
      ...(state !== "both"
        ? { appsState: state, reason: GITHUB_APPS_STATE_REASONS[state] }
        : {}),
    };
  }
}

/** The slice of the installer client the installation-repos port needs. */
export interface InstalledOrgsClient {
  listInstallableOrganizations(
    accountId?: string | null,
  ): Promise<{ login: string }[]>;
}

/**
 * Port over the installation port plus org discovery: the orgs the
 * installer can reach that carry an installation of the agent's App.
 */
export function createInstallationReposPort(
  base: AppInstallationPort,
  client: InstalledOrgsClient,
): InstallationReposPort {
  return {
    ...base,
    async listInstalled(appId, identity) {
      const out: { org: string; repos: string[] }[] = [];
      for (const { login } of await client.listInstallableOrganizations(
        identity?.accountId,
      )) {
        try {
          const repos = await base.listRepos(appId, [login], identity);
          out.push({ org: login, repos: repos[login] ?? [] });
        } catch (err) {
          if (err instanceof AppNotInstalledError) continue;
          throw err;
        }
      }
      return out.length === 0
        ? { status: "none" }
        : { status: "found", orgs: out };
    },
  };
}
