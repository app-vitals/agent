/**
 * admin/src/github-lookup-client.ts
 * GithubLookupClient: read-only lookups through the admin-level "lookup"
 * GitHub App (GHE-1.1), installed on each organization it needs to read.
 *
 * Flow per org: sign app JWT -> GET /orgs/{org}/installation (JWT) ->
 * POST /app/installations/{id}/access_tokens (JWT) -> read calls with the
 * installation token. Sibling of GithubEnterpriseClient: it shares the JWT
 * signer and the typed error (kinds keep rate limits and server errors
 * distinguishable from not-found), and never puts a token or key in a message.
 *
 * Endpoints follow GitHub's published REST OpenAPI description
 * (api.github.com.json); nothing here was verified live.
 */

import { signGithubAppJwt } from "./github-app-jwt.ts";
import {
  GithubEnterpriseError,
  mapGithubEnterpriseError,
} from "./github-enterprise-client.ts";

export type RepoRole =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none";

export const REPO_ROLES: readonly RepoRole[] = [
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
];

/**
 * Map GitHub's role string to a RepoRole. Exhaustive: an unknown role (for
 * example a custom repository role) is an error, never silently "none".
 */
export function mapRepoRole(role: unknown): RepoRole {
  if (
    typeof role === "string" &&
    (REPO_ROLES as readonly string[]).includes(role)
  ) {
    return role as RepoRole;
  }
  throw new GithubEnterpriseError(
    "unexpected",
    `GitHub collaborator permission: unknown role ${
      typeof role === "string" ? JSON.stringify(role.slice(0, 40)) : typeof role
    }`,
  );
}

export interface LookupRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
}

export interface LookupUser {
  id: number;
  login: string;
  type: string;
}

export interface LookupToken {
  token: string;
  expiresAt: string;
  installationId: number;
}

export interface GithubLookupClientOptions {
  appId: string;
  privateKey: string;
  apiBase?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const PER_PAGE = 100;
const MAX_PAGES = 100;
/** Refresh a cached installation token this long before it expires. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class GithubLookupClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly cached = new Map<string, LookupToken>();

  constructor(opts: GithubLookupClientOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Mint (or reuse a still-fresh) installation token for the lookup App on `org`. */
  async getOrgToken(org: string): Promise<LookupToken> {
    const key = org.toLowerCase();
    const hit = this.cached.get(key);
    if (
      hit &&
      Date.parse(hit.expiresAt) - this.now().getTime() > TOKEN_REFRESH_SKEW_MS
    ) {
      return hit;
    }
    const jwt = signGithubAppJwt({
      appId: this.appId,
      privateKey: this.privateKey,
      now: this.now(),
    });
    const inst = await this.request<{ id?: number }>(
      "GET",
      `/orgs/${encodeURIComponent(org)}/installation`,
      jwt,
      "GitHub org installation lookup",
    );
    if (typeof inst.data?.id !== "number") {
      throw new GithubEnterpriseError(
        "unexpected",
        "GitHub org installation lookup: response missing id",
      );
    }
    const minted = await this.request<{ token?: string; expires_at?: string }>(
      "POST",
      `/app/installations/${inst.data.id}/access_tokens`,
      jwt,
      "GitHub installation access token",
    );
    if (!minted.data?.token || !minted.data.expires_at) {
      throw new GithubEnterpriseError(
        "unexpected",
        "GitHub installation access token: response missing token or expires_at",
      );
    }
    const token: LookupToken = {
      token: minted.data.token,
      expiresAt: minted.data.expires_at,
      installationId: inst.data.id,
    };
    this.cached.set(key, token);
    return token;
  }

  /** List every repository the lookup App can see on `org` (paginated). */
  async listInstallationRepositories(org: string): Promise<LookupRepository[]> {
    const { token } = await this.getOrgToken(org);
    const all: LookupRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request<{ repositories?: RawRepository[] }>(
        "GET",
        `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
        token,
        "GitHub installation repositories",
      );
      const rows = res.data?.repositories;
      if (!Array.isArray(rows)) {
        throw new GithubEnterpriseError(
          "unexpected",
          "GitHub installation repositories: response is not a repository list",
        );
      }
      for (const r of rows) all.push(toRepository(r));
      const link = res.headers.get("link");
      const hasNext =
        link !== null ? /rel="next"/.test(link) : rows.length >= PER_PAGE;
      if (!hasNext) break;
    }
    return all;
  }

  /**
   * A user's role on `owner/repo`. Prefers `role_name` (carries maintain and
   * triage), falling back to the legacy `permission` field.
   */
  async getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<RepoRole> {
    const { token } = await this.getOrgToken(owner);
    const res = await this.request<{
      permission?: unknown;
      role_name?: unknown;
    }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
      token,
      "GitHub collaborator permission",
    );
    return mapRepoRole(res.data?.role_name ?? res.data?.permission);
  }

  /** Look up a user. A nonexistent login throws kind "not_found". */
  async getUser(org: string, login: string): Promise<LookupUser> {
    const { token } = await this.getOrgToken(org);
    const res = await this.request<{
      id?: number;
      login?: string;
      type?: string;
    }>(
      "GET",
      `/users/${encodeURIComponent(login)}`,
      token,
      "GitHub user lookup",
    );
    if (
      typeof res.data?.id !== "number" ||
      typeof res.data.login !== "string"
    ) {
      throw new GithubEnterpriseError(
        "unexpected",
        "GitHub user lookup: response missing id or login",
      );
    }
    return {
      id: res.data.id,
      login: res.data.login,
      type: res.data.type ?? "User",
    };
  }

  /**
   * Whether `username` is a member of `org`. GitHub answers 204 (member) or
   * 404 (not a member, or no such org); a 302 means the requester cannot see
   * the member list and is reported as an error, not as "not a member".
   */
  async isOrgMember(org: string, username: string): Promise<boolean> {
    const { token } = await this.getOrgToken(org);
    try {
      await this.request(
        "GET",
        `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
        token,
        "GitHub org membership",
      );
      return true;
    } catch (err) {
      if (err instanceof GithubEnterpriseError && err.kind === "not_found")
        return false;
      throw err;
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    bearer: string,
    context: string,
  ): Promise<{ status: number; headers: Headers; data: T }> {
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearer}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      // The underlying error is dropped on purpose: it must never echo headers.
      throw new GithubEnterpriseError("network", `${context}: network error`);
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      data = undefined;
    }
    if (!resp.ok) {
      throw mapGithubEnterpriseError(resp.status, resp.headers, data, context, [
        bearer,
        this.privateKey,
      ]);
    }
    return { status: resp.status, headers: resp.headers, data: data as T };
  }
}

interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  archived?: boolean;
}

function toRepository(r: RawRepository): LookupRepository {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private === true,
    archived: r.archived === true,
  };
}
