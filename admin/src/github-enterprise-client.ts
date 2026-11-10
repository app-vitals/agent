/**
 * admin/src/github-enterprise-client.ts
 * GithubEnterpriseClient: manages GitHub App installations on enterprise-owned
 * organizations, authenticated as a "installer" GitHub App that is itself
 * installed on the enterprise.
 *
 * Flow: sign app JWT -> GET /enterprises/{enterprise}/installation (JWT) ->
 * POST /app/installations/{id}/access_tokens (JWT) -> call the
 * /enterprises/{enterprise}/apps/... endpoints with the installation token.
 *
 * Repo add/remove on an installation is Phase 3 and intentionally not here.
 *
 * ── Verified findings (feed GHE-1.5 docs) ─────────────────────────────────
 * Source: github/rest-api-description descriptions/ghec/ghec.json (fetched
 * 2026-11-09) and docs.github.com "permissions required for GitHub Apps".
 * The enterprise endpoints exist ONLY in the ghec (and GHES) descriptions,
 * not in api.github.com.json; they are githubCloudOnly.
 *
 * - Install POST: POST /enterprises/{enterprise}/apps/organizations/{org}/installations
 *   body { client_id (required), repository_selection (required: all |
 *   selected | none), repositories (string[] of simple repo names, max 50,
 *   only for "selected") }. So YES it needs the TARGET App's client_id (not
 *   its numeric id). Returns 201 for a new installation and 200 when the app
 *   was already installed (suspended -> unsuspended, pending requests
 *   approved, pending update applied). Response is an `installation` object.
 *   "none" is only for apps that request no repository permissions.
 * - Enterprise installation token: GET /enterprises/{enterprise}/installation
 *   with the app JWT ("Get an enterprise installation for the authenticated
 *   app") returns the installation whose `id` is then used in the normal
 *   POST /app/installations/{installation_id}/access_tokens (JWT) call, which
 *   returns { token, expires_at (1h) }. The OpenAPI description documents the
 *   two calls separately; the combination is the documented path, but it was
 *   not exercised live (no live recording in this task).
 * - Installer app permissions (enterprise-level): `enterprise_organization_installations`
 *   (read | write). Docs page: read for GET installable_organizations and GET
 *   organizations/{org}/installations, write for the POST install (and DELETE).
 *   `enterprise_organization_installation_repositories` (read | write) is for
 *   the repositories endpoints, i.e. Phase 3, not needed here.
 * - Caller restriction: all enterprise endpoints "can only be called by a
 *   GitHub App installed on the enterprise that owns the organization".
 * - Collaborator-permission lookup (GET /repos/{owner}/{repo}/collaborators/
 *   {username}/permission, usable by GitHub Apps): the docs list it under
 *   repository permission "Metadata" read, NOT Administration. The returned
 *   `permission` reflects the highest grant across repo, team, org and
 *   enterprise. Whether Metadata read alone suffices at runtime was not
 *   verified live.
 * - Pagination: per_page (max 100, default 30) and page query params.
 * - NOT verified: secondary-rate-limit specifics for these endpoints (the
 *   docs page has no rate limit information); the 403/429 classification
 *   below follows GitHub's general rate-limit documentation.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { signGithubAppJwt } from "./github-app-jwt.ts";

// ─── Errors ───────────────────────────────────────────────────────────────────

export type GithubEnterpriseErrorKind =
  | "unauthorized" // 401
  | "permission" // 403, missing permission
  | "not_found" // 404
  | "validation" // 422
  | "rate_limit" // 429, or 403 primary/secondary rate limit
  | "server" // 5xx
  | "network" // fetch threw
  | "unexpected"; // other statuses, malformed body

export class GithubEnterpriseError extends Error {
  readonly kind: GithubEnterpriseErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: GithubEnterpriseErrorKind,
    message: string,
    opts?: { status?: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "GithubEnterpriseError";
    this.kind = kind;
    this.status = opts?.status;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

/**
 * Map an HTTP error response to a typed error. `secrets` are redacted from
 * the message so a token or key echoed by a server never propagates.
 */
export function mapGithubEnterpriseError(
  status: number,
  headers: Headers,
  body: unknown,
  context: string,
  secrets: readonly string[] = [],
): GithubEnterpriseError {
  let detail =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : "";
  for (const s of secrets) if (s) detail = detail.split(s).join("[redacted]");
  detail = detail.slice(0, 200);
  const message = `${context}: HTTP ${status}${detail ? ` ${detail}` : ""}`;

  const ra = Number(headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : undefined;
  const opts = { status, retryAfterSeconds };

  if (status === 429) return new GithubEnterpriseError("rate_limit", message, opts);
  if (status === 403) {
    const limited =
      headers.get("retry-after") !== null ||
      headers.get("x-ratelimit-remaining") === "0" ||
      /rate limit/i.test(detail);
    return new GithubEnterpriseError(limited ? "rate_limit" : "permission", message, opts);
  }
  if (status === 401) return new GithubEnterpriseError("unauthorized", message, opts);
  if (status === 404) return new GithubEnterpriseError("not_found", message, opts);
  if (status === 422) return new GithubEnterpriseError("validation", message, opts);
  if (status >= 500) return new GithubEnterpriseError("server", message, opts);
  return new GithubEnterpriseError("unexpected", message, opts);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type RepositorySelection = "all" | "selected" | "none";

export interface InstallableOrganization {
  id: number;
  login: string;
}

export interface AppInstallation {
  id: number;
  appId: number;
  appSlug: string;
  clientId?: string;
  accountLogin: string;
  repositorySelection: RepositorySelection;
}

export interface InstallOnOrgInput {
  /** Client ID of the App to install (not the numeric app id). */
  clientId: string;
  repositorySelection: RepositorySelection;
  /** Simple repo names (max 50); required when repositorySelection is "selected". */
  repositories?: string[];
}

export interface InstallOnOrgResult {
  installation: AppInstallation;
  /** true when GitHub returned 201; false (200) when already installed. */
  created: boolean;
}

export interface EnterpriseInstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
  /** Permissions granted to the minted token, as reported by GitHub (when present). */
  permissions?: Record<string, string>;
}

export interface GithubEnterpriseClientOptions {
  appId: string;
  enterprise: string;
  privateKey: string;
  apiBase?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const PER_PAGE = 100;
const MAX_PAGES = 100;
const MAX_REPOSITORIES = 50;
/** Refresh a cached installation token this long before it expires. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

// ─── Client ───────────────────────────────────────────────────────────────────

export class GithubEnterpriseClient {
  private readonly appId: string;
  private readonly enterprise: string;
  private readonly privateKey: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private cached?: EnterpriseInstallationToken;

  constructor(opts: GithubEnterpriseClientOptions) {
    this.appId = opts.appId;
    this.enterprise = opts.enterprise;
    this.privateKey = opts.privateKey;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Mint (or reuse a still-fresh) enterprise installation token. */
  async getInstallationToken(): Promise<EnterpriseInstallationToken> {
    if (
      this.cached &&
      Date.parse(this.cached.expiresAt) - this.now().getTime() > TOKEN_REFRESH_SKEW_MS
    ) {
      return this.cached;
    }
    const jwt = signGithubAppJwt({
      appId: this.appId,
      privateKey: this.privateKey,
      now: this.now(),
    });
    const ent = encodeURIComponent(this.enterprise);
    const inst = await this.request<{ id?: number }>(
      "GET",
      `/enterprises/${ent}/installation`,
      jwt,
      "GitHub enterprise installation lookup",
    );
    if (typeof inst.data?.id !== "number") {
      throw new GithubEnterpriseError(
        "unexpected",
        "GitHub enterprise installation lookup: response missing id",
      );
    }
    const minted = await this.request<{
      token?: string;
      expires_at?: string;
      permissions?: Record<string, string>;
    }>(
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
    this.cached = {
      token: minted.data.token,
      expiresAt: minted.data.expires_at,
      installationId: inst.data.id,
      ...(minted.data.permissions && typeof minted.data.permissions === "object"
        ? { permissions: minted.data.permissions }
        : {}),
    };
    return this.cached;
  }

  /** List all organizations the installer App can install Apps on (paginated). */
  async listInstallableOrganizations(): Promise<InstallableOrganization[]> {
    const ent = encodeURIComponent(this.enterprise);
    const rows = await this.paginate<{ id: number; login: string }>(
      `/enterprises/${ent}/apps/installable_organizations`,
      "GitHub installable organizations",
    );
    return rows.map((r) => ({ id: r.id, login: r.login }));
  }

  /** List all App installations on an enterprise-owned org (paginated). */
  async listOrgInstallations(org: string): Promise<AppInstallation[]> {
    const ent = encodeURIComponent(this.enterprise);
    const rows = await this.paginate<RawInstallation>(
      `/enterprises/${ent}/apps/organizations/${encodeURIComponent(org)}/installations`,
      "GitHub org installations",
    );
    return rows.map(toInstallation);
  }

  /** Install an App on an enterprise-owned org. */
  async installOnOrg(org: string, input: InstallOnOrgInput): Promise<InstallOnOrgResult> {
    if (!input.clientId) {
      throw new GithubEnterpriseError("validation", "installOnOrg: clientId is required");
    }
    const repos = input.repositories ?? [];
    if (input.repositorySelection === "selected" && (repos.length === 0 || repos.length > MAX_REPOSITORIES)) {
      throw new GithubEnterpriseError(
        "validation",
        `installOnOrg: repositories must list 1-${MAX_REPOSITORIES} names when repositorySelection is "selected"`,
      );
    }
    const body: Record<string, unknown> = {
      client_id: input.clientId,
      repository_selection: input.repositorySelection,
    };
    if (input.repositorySelection === "selected") body.repositories = repos;
    const { token } = await this.getInstallationToken();
    const ent = encodeURIComponent(this.enterprise);
    const res = await this.request<RawInstallation>(
      "POST",
      `/enterprises/${ent}/apps/organizations/${encodeURIComponent(org)}/installations`,
      token,
      "GitHub install App on org",
      body,
    );
    if (typeof res.data?.id !== "number") {
      throw new GithubEnterpriseError("unexpected", "GitHub install App on org: response missing id");
    }
    return { installation: toInstallation(res.data), created: res.status === 201 };
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async paginate<T>(path: string, context: string): Promise<T[]> {
    const { token } = await this.getInstallationToken();
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request<T[]>(
        "GET",
        `${path}?per_page=${PER_PAGE}&page=${page}`,
        token,
        context,
      );
      if (!Array.isArray(res.data)) {
        throw new GithubEnterpriseError("unexpected", `${context}: response is not a list`);
      }
      all.push(...res.data);
      const link = res.headers.get("link");
      const hasNext = link !== null ? /rel="next"/.test(link) : res.data.length >= PER_PAGE;
      if (!hasNext) break;
    }
    return all;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    bearer: string,
    context: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; data: T }> {
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearer}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

interface RawInstallation {
  id: number;
  app_id: number;
  app_slug: string;
  client_id?: string;
  account?: { login?: string } | null;
  repository_selection: RepositorySelection;
}

function toInstallation(r: RawInstallation): AppInstallation {
  return {
    id: r.id,
    appId: r.app_id,
    appSlug: r.app_slug,
    ...(r.client_id ? { clientId: r.client_id } : {}),
    accountLogin: r.account?.login ?? "",
    repositorySelection: r.repository_selection,
  };
}
