/**
 * admin/src/user-repo-access-resolver.ts
 * UserRepoAccessResolver: the single place that answers "what can GitHub user
 * X do on which repos" through the lookup App (GHE-2.2 client) across the orgs
 * the installer App (GHE-1.1) can install on.
 *
 * Completeness contract (reused by later phases):
 * - Unknown is never none. A repo that could not be checked is absent from
 *   `repos` and counted in `unresolved`. Only a level GitHub actually returned
 *   (including an explicit "none") appears in `repos`.
 * - `complete` is true only when the user exists, was verified, and every org
 *   is "ok".
 *
 * 403/429 mapping rule:
 * - Org level (getOrgToken / listing repos): 404 on the installation ->
 *   lookup_app_not_installed; rate limit (429, or 403 rate limit) ->
 *   rate_limited; anything else (incl. a plain 403) -> error.
 * - Mid-org (per-repo permission call): a rate limit or 403 stops the org's
 *   remaining calls (in-flight ones may finish and are kept). With at least
 *   one repo resolved the org is "partial"; with none resolved a rate limit is
 *   "rate_limited" and a plain 403 is "error".
 * - Any other per-repo failure (404, 5xx, network, unknown role) leaves that
 *   repo unresolved without stopping the org; the org is "partial" if some repo
 *   resolved, else "error".
 *
 * Ports are injected (no DB, no global state); time and concurrency too.
 * Outputs carry no tokens and error messages are never copied into results.
 */

import {
  GithubEnterpriseError,
  type InstallableOrganization,
} from "./github-enterprise-client.ts";
import type {
  LookupRepository,
  LookupToken,
  LookupUser,
  RepoRole,
} from "./github-lookup-client.ts";

export type OrgAccessStatus =
  | "ok"
  | "lookup_app_not_installed"
  | "rate_limited"
  | "partial"
  | "error";

export interface ResolvedRepoAccess {
  fullName: string;
  level: RepoRole;
  canPush: boolean;
}

export interface OrgAccessResult {
  org: string;
  status: OrgAccessStatus;
  /** Only repos whose level was actually resolved. */
  repos: ResolvedRepoAccess[];
  /** Repos that could not be checked. Never reported as "none". */
  unresolved: number;
  /** Why the org is not "ok" when the cause is the lookup install scope. */
  reason?: string;
}

/** Shown when the lookup App is installed on selected repositories only. */
export const SELECTED_REPOS_REASON =
  "lookup app is installed on selected repositories only; install it on all repositories";

export interface UserRepoAccessResult {
  username: string;
  outcome: "ok" | "user_not_found";
  /** False when no org could verify the user exists (e.g. rate limited). */
  userVerified: boolean;
  orgs: OrgAccessResult[];
  /** Sum of per-org unresolved counts. */
  unresolved: number;
  /** True only when the user is verified and every org is "ok". */
  complete: boolean;
  checkedAt: string;
}

/** Installer-side port: GithubEnterpriseClient satisfies this. */
export interface InstallerPort {
  listInstallableOrganizations(): Promise<InstallableOrganization[]>;
}

/** Lookup-side port: GithubLookupClient satisfies this. */
export interface LookupPort {
  getOrgToken(org: string): Promise<LookupToken>;
  getUser(org: string, login: string): Promise<LookupUser>;
  listInstallationRepositories(org: string): Promise<LookupRepository[]>;
  getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<RepoRole>;
}

export interface UserRepoAccessResolverOptions {
  installer: InstallerPort;
  lookup: LookupPort;
  now?: () => Date;
  /** Max concurrent per-repo permission calls (default 5). */
  concurrency?: number;
}

export const DEFAULT_CONCURRENCY = 5;

const PUSH_ROLES: ReadonlySet<RepoRole> = new Set([
  "admin",
  "maintain",
  "write",
]);

/** admin, maintain and write can push; triage, read and none cannot. */
export function canPushForRole(role: RepoRole): boolean {
  return PUSH_ROLES.has(role);
}

function kindOf(e: unknown): string | undefined {
  return e instanceof GithubEnterpriseError ? e.kind : undefined;
}

export class UserRepoAccessResolver {
  private readonly installer: InstallerPort;
  private readonly lookup: LookupPort;
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(opts: UserRepoAccessResolverOptions) {
    this.installer = opts.installer;
    this.lookup = opts.lookup;
    this.now = opts.now ?? (() => new Date());
    this.concurrency = Math.max(
      1,
      Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY),
    );
  }

  async resolve(username: string): Promise<UserRepoAccessResult> {
    const candidates = (
      await this.installer.listInstallableOrganizations()
    ).map((o) => o.login);
    const verdict = await this.verifyUser(candidates, username);
    if (verdict === "not_found") {
      return this.result(username, "user_not_found", true, []);
    }
    const orgs: OrgAccessResult[] = [];
    for (const org of candidates) {
      orgs.push(await this.resolveOrg(org, username));
    }
    return this.result(username, "ok", verdict === "verified", orgs);
  }

  /** One getUser check up front, on the first org that can mint a token. */
  private async verifyUser(
    orgs: string[],
    username: string,
  ): Promise<"verified" | "not_found" | "unverified"> {
    for (const org of orgs) {
      try {
        await this.lookup.getOrgToken(org);
      } catch {
        continue; // Not installed / rate limited / other: try the next org.
      }
      try {
        await this.lookup.getUser(org, username);
        return "verified";
      } catch (e) {
        // The token minted, so a 404 here means "no such user".
        if (kindOf(e) === "not_found") return "not_found";
      }
    }
    return "unverified";
  }

  private async resolveOrg(
    org: string,
    username: string,
  ): Promise<OrgAccessResult> {
    let repos: LookupRepository[];
    let selectedOnly = false;
    try {
      const token = await this.lookup.getOrgToken(org);
      selectedOnly = token.repositorySelection === "selected";
      repos = await this.lookup.listInstallationRepositories(org);
    } catch (e) {
      return orgLevelFailure(org, e);
    }

    const resolved = new Map<string, ResolvedRepoAccess>();
    let stop: "rate_limit" | "permission" | undefined;
    let next = 0;

    const worker = async () => {
      while (!stop && next < repos.length) {
        const repo = repos[next++];
        try {
          const level = await this.lookup.getCollaboratorPermission(
            org,
            repo.name,
            username,
          );
          resolved.set(repo.fullName, {
            fullName: repo.fullName,
            level,
            canPush: canPushForRole(level),
          });
        } catch (e) {
          const kind = kindOf(e);
          if (kind === "rate_limit" || kind === "permission") {
            stop = stop === "rate_limit" ? stop : kind;
          }
          // Other failures: repo stays unresolved, org keeps going.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, repos.length) }, worker),
    );

    // Preserve listing order regardless of completion order.
    const list = repos
      .map((r) => resolved.get(r.fullName))
      .filter((r): r is ResolvedRepoAccess => r !== undefined);
    const unresolved = repos.length - list.length;
    let status: OrgAccessStatus;
    if (unresolved === 0) status = "ok";
    else if (list.length > 0) status = "partial";
    else if (stop === "rate_limit") status = "rate_limited";
    else status = "error";
    // A selected-only install lists a subset that looks complete: never "ok".
    if (selectedOnly && status === "ok") {
      return {
        org,
        status: "partial",
        repos: list,
        unresolved,
        reason: SELECTED_REPOS_REASON,
      };
    }
    return { org, status, repos: list, unresolved };
  }

  private result(
    username: string,
    outcome: "ok" | "user_not_found",
    userVerified: boolean,
    orgs: OrgAccessResult[],
  ): UserRepoAccessResult {
    return {
      username,
      outcome,
      userVerified,
      orgs,
      unresolved: orgs.reduce((n, o) => n + o.unresolved, 0),
      complete:
        outcome === "ok" &&
        userVerified &&
        orgs.every((o) => o.status === "ok"),
      checkedAt: this.now().toISOString(),
    };
  }
}

function orgLevelFailure(org: string, e: unknown): OrgAccessResult {
  const kind = kindOf(e);
  const status: OrgAccessStatus =
    kind === "not_found"
      ? "lookup_app_not_installed"
      : kind === "rate_limit"
        ? "rate_limited"
        : "error";
  return { org, status, repos: [], unresolved: 0 };
}
