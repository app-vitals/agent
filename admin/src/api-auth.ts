/**
 * admin/src/api-auth.ts
 * Combined admin auth middleware — accepts either a session cookie OR a bearer token.
 *
 * Bearer check runs first (when Authorization header is present).
 * If Authorization header is absent, falls through to session cookie check.
 * If Authorization header is present but invalid, rejects immediately (401) —
 * does NOT fall through to the cookie path.
 */

import type { Caller } from "@app-vitals/agent-lib/request-context";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  type CallerScopeResolver,
  memberOnlyCallerScopeResolver,
  scopeIncludesAgent,
} from "./caller-scope.ts";
import { ForbiddenError } from "./errors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What kind of credential authenticated the request.
 * admin → `*` key; agent → `<agentId>` key or DB agent token;
 * platform-read / platform-ops → `platform.read` / `platform.ops` keys.
 * Not set for session cookies (they are described by isAdmin/callerEmail).
 */
export type AdminScopeKind =
  | "admin"
  | "agent"
  | "platform-read"
  | "platform-ops";

export interface AdminScope {
  kind: AdminScopeKind;
  agentId?: string;
}

export type AdminAuthEnv = {
  Variables: {
    isAdmin: boolean;
    caller: Caller;
    scope?: AdminScope;
    /**
     * Lowercased session email. Set only for session-cookie callers (admin or
     * member) — never for bearer callers. For a non-admin cookie, the
     * middleware has already verified AgentMember access to the route's agent.
     */
    callerEmail?: string;
  };
};

/**
 * No-op middleware for routes declared with policy kind "public".
 * Allows unauthenticated requests to pass through without a 401.
 */
export const publicNoAuthMiddleware: MiddlewareHandler<AdminAuthEnv> = async (
  _c,
  next,
) => {
  await next();
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";

// Matches /agents/{agentId}/... routes — used for per-agent scope enforcement.
const AGENT_ROUTE_RE = /^\/agents\/([^/]+)/;

/**
 * Extract the agent id from an /agents/{id}/... path, or null if the path has
 * no agent segment. Static segments (reconcile, all, chat-tokens) are returned
 * as-is; they never match an AgentMember row, so scoped callers are denied.
 */
export function extractAgentId(path: string): string | null {
  return AGENT_ROUTE_RE.exec(path)?.[1] ?? null;
}

// ─── Platform scopes ──────────────────────────────────────────────────────────

export const PLATFORM_READ_SCOPE = "platform.read";
export const PLATFORM_OPS_SCOPE = "platform.ops";

export interface PlatformOpsRoute {
  method: string;
  /** Path template; `{name}` matches exactly one segment. */
  path: string;
  /** Also match any deeper path below `path` (e.g. /agents/{id}/repos/{repo}). */
  subpaths?: boolean;
}

/**
 * The only mutating routes a `platform.ops` key may call (everything else
 * mutating is 403, as is every mutating method for `platform.read`).
 * PATCH /agents/{id} additionally refuses `accountId` in its handler.
 * Entries whose routes are not mounted yet are wired by their own tasks.
 */
export const PLATFORM_OPS_ROUTES: readonly PlatformOpsRoute[] = [
  { method: "PATCH", path: "/agents/{id}" },
  { method: "POST", path: "/agents/{id}/repos", subpaths: true },
  { method: "DELETE", path: "/agents/{id}/repos", subpaths: true },
  { method: "PATCH", path: "/agents/{id}/crons/{cronId}" },
  { method: "POST", path: "/agents/{id}/ask" },
  { method: "POST", path: "/agents/{id}/crons/{cronId}/run-now" },
  { method: "POST", path: "/agents/{id}/chat-credentials", subpaths: true },
  { method: "DELETE", path: "/agents/{id}/chat-credentials", subpaths: true },
];

/**
 * Routes an agent-scoped key may call on ANOTHER agent's path. The middleware
 * skips its path-agent check for them; the handler binds the caller to a body
 * field instead (POST /agents/{id}/ask: `from` must equal the key's agent, so
 * an agent can only ask as itself — never impersonate another).
 */
export const AGENT_CROSS_ROUTES: readonly PlatformOpsRoute[] = [
  { method: "POST", path: "/agents/{id}/ask" },
];

function routeMatchers(routes: readonly PlatformOpsRoute[]) {
  const matchers = routes.map((r) => ({
    method: r.method,
    re: new RegExp(
      `^${r.path.replace(/\{[^}]+\}/g, "[^/]+")}${r.subpaths ? "(?:/.*)?" : ""}/?$`,
    ),
  }));
  return (method: string, path: string): boolean =>
    matchers.some((m) => m.method === method && m.re.test(path));
}

const isPlatformOpsRoute = routeMatchers(PLATFORM_OPS_ROUTES);
const isAgentCrossRoute = routeMatchers(AGENT_CROSS_ROUTES);

/**
 * Handler-side guard for routes on PLATFORM_OPS_ROUTES. The middleware already
 * 403s other callers' methods; this keeps a `platform.read` caller out even if
 * a handler is mounted behind a different method. Admin, agent and session
 * callers are unaffected.
 */
export function requireScope(
  c: { get: (k: "scope") => unknown },
  need: "ops",
): void {
  const kind = (c.get("scope") as AdminScope | undefined)?.kind;
  if (need === "ops" && kind === "platform-read") {
    throw new ForbiddenError("Platform ops scope required");
  }
}

// ─── Admin API key parsing ────────────────────────────────────────────────────

/**
 * Represents a parsed admin API key entry.
 * scope === "*" → admin (bypasses all per-agent scope checks)
 * scope === "<agentId>" → scoped to a single agent
 * scope === "platform.read" | "platform.ops" → platform reader / operator
 */
export interface AdminApiKey {
  name: string;
  scope: string;
}

/**
 * Parse the SHIPWRIGHT_ADMIN_API_KEYS env var into a Map<token, AdminApiKey>.
 * Format: comma-separated "name:token:scope" tuples.
 * Example: "bodhi:sk_bodhi_abc:*,svc:sk_svc_xyz:agent-id-123,ro:tok:platform.read"
 *
 * Scope names must not contain a colon: the last colon-separated segment IS
 * the scope, so a colon would corrupt the token. Hence the dot-spelled
 * `platform.read` / `platform.ops`.
 *
 * Tokens may contain embedded colons — first segment is name, last is scope,
 * everything in between is the token.
 *
 * Returns an empty map if the env var is missing or empty.
 */
export function parseAdminApiKeys(
  envStr: string | undefined,
): Map<string, AdminApiKey> {
  const map = new Map<string, AdminApiKey>();
  if (!envStr) return map;

  for (const entry of envStr.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    // parts[0]=name, parts[1..n-1]=token (may contain colons), parts[n]=scope
    if (parts.length < 3) continue;
    const name = parts[0];
    const scope = parts[parts.length - 1];
    const token = parts.slice(1, parts.length - 1).join(":");
    if (name && token && scope) {
      map.set(token, { name, scope });
    }
  }

  return map;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns a Hono middleware that accepts either:
 * (a) a valid session cookie (JWT in admin_session cookie), OR
 * (b) a valid bearer token — checked in this order:
 *     1. Matches a SHIPWRIGHT_ADMIN_API_KEYS env key with scope=* → isAdmin, bypass
 *     2. Matches a SHIPWRIGHT_ADMIN_API_KEYS env key with scope=<agentId> → enforce agentId
 *     3. Validates via agentTokenService.validate() (DB token path)
 *
 * Decision tree:
 *   1. Authorization header present?
 *      - Yes, starts with "Bearer " → check env keys, then DB token → pass or 401
 *      - Yes, malformed → 401 (no cookie fallback)
 *      - No → try session cookie
 *   2. Cookie present?
 *      - Yes → verify JWT → pass or 401
 *      - No → 401
 */
export function createAdminAuthMiddleware(deps: {
  sessionSecret: string;
  agentTokenService: Pick<AgentTokenService, "validate">;
  adminApiKeys?: Map<string, AdminApiKey>;
  /** Required to authorize non-admin cookie sessions; absent → they are denied on agent routes. */
  agentMemberService?: Pick<AgentMemberService, "listByEmail">;
  /**
   * Account-aware caller-scope resolver (SSP-2.1). Defaults to the
   * AgentMember-only resolver built from agentMemberService.
   */
  callerScopeResolver?: CallerScopeResolver;
}): MiddlewareHandler<AdminAuthEnv> {
  const { sessionSecret, agentTokenService, adminApiKeys, agentMemberService } =
    deps;
  const callerScopeResolver =
    deps.callerScopeResolver ??
    (agentMemberService
      ? memberOnlyCallerScopeResolver(agentMemberService)
      : undefined);

  async function isSessionRouteAllowed(
    method: string,
    path: string,
    email: string,
  ): Promise<boolean> {
    // POST /agents (SSP-4.2): the handler resolves the caller's account and
    // denies callers without one, so the middleware only lets it through.
    if (path === "/agents" || path === "/agents/") {
      return method === "GET" || method === "POST";
    }
    const agentId = extractAgentId(path);
    if (!agentId || !callerScopeResolver) return false;
    return scopeIncludesAgent(await callerScopeResolver(email, false), agentId);
  }

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader !== undefined) {
      // Authorization header is present — bearer token path.
      // Do NOT fall through to cookie check on failure.
      if (!authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }
      const raw = authHeader.slice(7);

      // (1) Check admin API keys first (env-based, no DB round-trip).
      if (adminApiKeys?.size) {
        const envKey = adminApiKeys.get(raw);
        if (envKey) {
          if (envKey.scope === "*") {
            // Admin key — bypass all scope checks.
            c.set("isAdmin", true);
            c.set("caller", { name: envKey.name, scope: "*" });
            c.set("scope", { kind: "admin" });
            return next();
          }
          if (
            envKey.scope === PLATFORM_READ_SCOPE ||
            envKey.scope === PLATFORM_OPS_SCOPE
          ) {
            const method = c.req.method;
            const read = method === "GET" || method === "HEAD";
            const ops =
              envKey.scope === PLATFORM_OPS_SCOPE &&
              isPlatformOpsRoute(method, c.req.path);
            if (!read && !ops) return c.json({ error: "Forbidden" }, 403);
            c.set("isAdmin", false);
            c.set("caller", { name: envKey.name, scope: envKey.scope });
            c.set("scope", {
              kind:
                envKey.scope === PLATFORM_OPS_SCOPE
                  ? "platform-ops"
                  : "platform-read",
            });
            return next();
          }
          // Scoped key — enforce route agentId matches key scope.
          const match = AGENT_ROUTE_RE.exec(c.req.path);
          if (
            match &&
            envKey.scope !== match[1] &&
            !isAgentCrossRoute(c.req.method, c.req.path)
          ) {
            return c.json({ error: "Forbidden" }, 403);
          }
          // Non-agent routes: scoped keys are permitted (no agentId to enforce against).
          // All current /agents/* routes match AGENT_ROUTE_RE — revisit if that changes.
          c.set("isAdmin", false);
          c.set("caller", { name: envKey.name, scope: envKey.scope });
          c.set("scope", { kind: "agent", agentId: envKey.scope });
          return next();
        }
      }

      // (2) Fall through to DB token path (AgentTokenService).
      const result = await agentTokenService.validate(raw);
      if (!result) {
        return c.json({ error: "Unauthorized" }, 401, {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        });
      }
      // Enforce per-agent scope: token must belong to the agent being accessed.
      // c.req.param() is not available in global middleware (params resolve only at
      // handler dispatch), so we extract the agent ID directly from the URL path.
      const match = AGENT_ROUTE_RE.exec(c.req.path);
      if (
        match &&
        result.agentId !== match[1] &&
        !isAgentCrossRoute(c.req.method, c.req.path)
      ) {
        return c.json({ error: "Forbidden" }, 403);
      }
      // DB token path — per-agent bearer, not an admin.
      c.set("isAdmin", false);
      c.set("caller", { name: result.agentId, scope: result.agentId });
      c.set("scope", { kind: "agent", agentId: result.agentId });
      return next();
    }

    // No Authorization header — try session cookie.
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    let email: string;
    let sessionIsAdmin: boolean;
    try {
      const payload = (await verify(
        sessionToken,
        sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.userId !== "string" ||
        !payload.userId ||
        typeof payload.email !== "string" ||
        !payload.email
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      email = payload.email.toLowerCase();
      // Strict: a missing/non-true claim (e.g. a pre-claim cookie) is non-admin.
      sessionIsAdmin = payload.isAdmin === true;
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("isAdmin", sessionIsAdmin);
    c.set("caller", { name: email, scope: "session" });
    c.set("callerEmail", email);
    if (sessionIsAdmin) return next();

    // Non-admin cookie: GET /agents (handler filters to memberships) and
    // /agents/:id/** for member agents only. Everything else is 403.
    if (!(await isSessionRouteAllowed(c.req.method, c.req.path, email))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  };
}
