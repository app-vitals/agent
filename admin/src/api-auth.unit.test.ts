/**
 * admin/src/api-auth.unit.test.ts
 * Unit tests for the combined admin auth middleware (bearer token + session cookie).
 *
 * Pure logic — mocks agentTokenService, injects a known sessionSecret.
 * No real DB, no real JWT library calls beyond what Hono's own helpers do.
 */

import { describe, expect, it } from "bun:test";
import type { Caller } from "@app-vitals/agent-lib/request-context";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { AgentTokenService, AgentTokenValidated } from "./agent-tokens.ts";
import type { AdminAuthEnv } from "./api-auth.ts";
import {
  createAdminAuthMiddleware,
  extractAgentId,
  PLATFORM_OPS_ROUTES,
  parseAdminApiKeys,
  requireScope,
} from "./api-auth.ts";
import { createCallerScopeResolver } from "./caller-scope.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-session-secret-exactly-32-bytes!";
const VALID_RAW_TOKEN = "valid-raw-token-hex-string";
const AGENT_ID = "agent-abc-123";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a valid session JWT */
async function makeSessionJwt(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      isAdmin: true,
      userId: "user-1",
      email: "admin@example.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

/** Build a minimal Hono app protected by the middleware under test */
function buildApp(
  validateFn: (raw: string) => Promise<AgentTokenValidated | null>,
  adminApiKeys?: Map<string, { name: string; scope: string }>,
): Hono<AdminAuthEnv> {
  const mockTokenService: Pick<AgentTokenService, "validate"> = {
    validate: validateFn,
  };

  const app = new Hono<AdminAuthEnv>();
  app.use(
    "*",
    createAdminAuthMiddleware({
      sessionSecret: SESSION_SECRET,
      agentTokenService: mockTokenService,
      adminApiKeys,
    }),
  );
  app.get("/test", (c) => c.json({ ok: true, caller: c.get("caller") }));
  // Scoped agent route — mirrors real admin API pattern
  app.get("/agents/:id/envs", (c) =>
    c.json({ agentId: c.req.param("id"), caller: c.get("caller") }),
  );
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createAdminAuthMiddleware — no auth", () => {
  it("returns 401 when no Authorization header and no cookie", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});

describe("createAdminAuthMiddleware — session cookie", () => {
  it("passes when a valid session cookie is present", async () => {
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt();
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when session cookie is signed with wrong secret", async () => {
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt("wrong-secret-32-bytes-exactly!!!");
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when session cookie is not a valid JWT", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Cookie: "admin_session=not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when session cookie JWT is missing required fields", async () => {
    // Sign a JWT missing userId/email
    const jwt = await sign(
      {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SESSION_SECRET,
      "HS256",
    );
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("createAdminAuthMiddleware — bearer token", () => {
  it("passes when a valid bearer token is provided", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when bearer token is invalid (validate returns null)", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when bearer token is revoked (validate returns null for revoked)", async () => {
    // validate() returns null for revoked tokens — same branch
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer revoked-token-value" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 immediately when Authorization header is present but invalid — does NOT fall through to cookie", async () => {
    // Authorization header present + invalid → reject, even if a valid cookie is also present
    const jwt = await makeSessionJwt();
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: {
        Authorization: "Bearer invalid-token",
        Cookie: `admin_session=${jwt}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("falls through to session cookie when Authorization header is absent", async () => {
    // No Authorization header → try cookie path → should succeed
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt();
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with WWW-Authenticate when Authorization header is malformed", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 with WWW-Authenticate when bearer token is invalid", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
  });
});

describe("createAdminAuthMiddleware — bearer token scope enforcement", () => {
  it("passes when token agentId matches the :id route param", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(AGENT_ID);
  });

  it("returns 403 when token agentId does not match the :id route param", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/agents/agent-different-id/envs", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("passes for routes without an :id param (no scope to enforce)", async () => {
    // Unscoped route — token is valid, no :id to compare against
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

// ─── Admin API key tests ───────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-key-scope-star";
const SCOPED_TOKEN = "scoped-key-for-agent";

describe("parseAdminApiKeys", () => {
  it("returns empty map for undefined input", () => {
    const map = parseAdminApiKeys(undefined);
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty string", () => {
    const map = parseAdminApiKeys("");
    expect(map.size).toBe(0);
  });

  it("parses a single admin key with scope=*", () => {
    const map = parseAdminApiKeys("admin:admin-key-scope-star:*");
    expect(map.size).toBe(1);
    const entry = map.get("admin-key-scope-star");
    expect(entry).toEqual({ name: "admin", scope: "*" });
  });

  it("parses a scoped key with agentId scope", () => {
    const map = parseAdminApiKeys(`svc:${SCOPED_TOKEN}:${AGENT_ID}`);
    expect(map.size).toBe(1);
    expect(map.get(SCOPED_TOKEN)).toEqual({ name: "svc", scope: AGENT_ID });
  });

  it("parses multiple keys from comma-separated string", () => {
    const map = parseAdminApiKeys(
      `admin:${ADMIN_TOKEN}:*,svc:${SCOPED_TOKEN}:${AGENT_ID}`,
    );
    expect(map.size).toBe(2);
    expect(map.get(ADMIN_TOKEN)).toEqual({ name: "admin", scope: "*" });
    expect(map.get(SCOPED_TOKEN)).toEqual({ name: "svc", scope: AGENT_ID });
  });

  it("handles tokens with embedded colons", () => {
    const map = parseAdminApiKeys("admin:sk:abc:def:*");
    expect(map.size).toBe(1);
    expect(map.get("sk:abc:def")).toEqual({ name: "admin", scope: "*" });
  });

  it("skips malformed entries with fewer than 3 parts", () => {
    const map = parseAdminApiKeys("bad-entry,admin:token:*");
    expect(map.size).toBe(1);
    expect(map.get("token")).toEqual({ name: "admin", scope: "*" });
  });
});

describe("createAdminAuthMiddleware — admin API keys", () => {
  it("admin key with scope=* bypasses all scope enforcement", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    // validateFn always returns null — should NOT be called
    let validateCalled = false;
    const app = buildApp(async () => {
      validateCalled = true;
      return null;
    }, adminApiKeys);

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(validateCalled).toBe(false);
  });

  it("admin key accepted for any route (no agent ID in path)", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("scoped admin key enforces agentId match on agent routes", async () => {
    const adminApiKeys = new Map([
      [SCOPED_TOKEN, { name: "svc", scope: AGENT_ID }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/agents/different-agent/envs", {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("scoped admin key allows access when agentId matches scope", async () => {
    const adminApiKeys = new Map([
      [SCOPED_TOKEN, { name: "svc", scope: AGENT_ID }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(AGENT_ID);
  });

  it("invalid bearer 401 when neither env key nor DB token matches", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer unknown-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("absent SHIPWRIGHT_ADMIN_API_KEYS env var is a no-op (falls through to DB path)", async () => {
    // No adminApiKeys provided — should fall through to validateFn (DB path)
    let validateCalled = false;
    const app = buildApp(async (raw) => {
      validateCalled = true;
      return raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null;
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(validateCalled).toBe(true);
  });
});

// ─── Shared Caller tests (AOB-3.4) ─────────────────────────────────────────────

describe("createAdminAuthMiddleware — shared Caller", () => {
  it("sets caller = {name, scope: '*'} for an admin env key", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({ name: "admin", scope: "*" });
  });

  it("sets caller = {name, scope: agentId} for a scoped env key", async () => {
    const adminApiKeys = new Map([
      [SCOPED_TOKEN, { name: "svc", scope: AGENT_ID }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({ name: "svc", scope: AGENT_ID });
  });

  it("sets caller = {name: agentId, scope: agentId} for a DB agent token", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({ name: AGENT_ID, scope: AGENT_ID });
  });

  it("sets caller = {name: email, scope: 'session'} for a session cookie", async () => {
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt();

    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({
      name: "admin@example.com",
      scope: "session",
    });
  });
});

// ─── Non-admin cookie scoping ─────────────────────────────────────────────────

async function makeMemberJwt(
  email = "Member@Example.com",
  isAdmin?: boolean,
): Promise<string> {
  return sign(
    {
      ...(isAdmin === undefined ? {} : { isAdmin }),
      userId: "user-2",
      email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

function buildScopedApp(memberOf: Array<[string, string]>) {
  const app = new Hono<AdminAuthEnv>();
  app.use(
    "*",
    createAdminAuthMiddleware({
      sessionSecret: SESSION_SECRET,
      agentTokenService: { validate: async () => null },
      agentMemberService: {
        listByEmail: async (email) =>
          memberOf
            .filter(([, e]) => e === email)
            .map(([agentId]) => ({ agentId }) as never),
      },
    }),
  );
  app.all("*", (c) =>
    c.json({
      isAdmin: c.get("isAdmin"),
      callerEmail: c.get("callerEmail"),
    }),
  );
  return app;
}

describe("createAdminAuthMiddleware — non-admin session cookie scoping", () => {
  const member: Array<[string, string]> = [[AGENT_ID, "member@example.com"]];

  it("treats a cookie without the isAdmin claim as non-admin and exposes the lowercased email", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt();
    const res = await app.request("/agents", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isAdmin: false,
      callerEmail: "member@example.com",
    });
  });

  it("treats isAdmin: false the same as a missing claim", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt("member@example.com", false);
    const res = await app.request("/agents/other-agent/envs", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  it("allows /agents/:id/** for a member agent", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt();
    const res = await app.request(`/agents/${AGENT_ID}/crons`, {
      method: "PATCH",
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 for an agent outside the membership", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt();
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const res = await app.request("/agents/other-agent", {
        method,
        headers: { Cookie: `admin_session=${jwt}` },
      });
      expect(res.status).toBe(403);
    }
  });

  it("lets a scoped cookie reach POST /agents (handler enforces the account) but not other collection routes", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt();
    const create = await app.request("/agents", {
      method: "POST",
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(create.status).toBe(200);
    const cases: Array<[string, string]> = [
      ["POST", "/agents/reconcile"],
      ["GET", "/agents/all/cron-runs/stats"],
      ["GET", "/agents/chat-tokens/daily/stats"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, {
        method,
        headers: { Cookie: `admin_session=${jwt}` },
      });
      expect(res.status).toBe(403);
    }
  });

  it("returns 403 for non-agent paths", async () => {
    const app = buildScopedApp(member);
    const jwt = await makeMemberJwt();
    const res = await app.request("/other", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  it("denies agent routes when no agentMemberService is wired (fail closed)", async () => {
    const app = new Hono<AdminAuthEnv>();
    app.use(
      "*",
      createAdminAuthMiddleware({
        sessionSecret: SESSION_SECRET,
        agentTokenService: { validate: async () => null },
      }),
    );
    app.all("*", (c) => c.json({ ok: true }));
    const jwt = await makeMemberJwt();
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  it("admin cookie bypasses membership checks", async () => {
    const app = buildScopedApp([]);
    const jwt = await makeMemberJwt("admin@example.com", true);
    const res = await app.request("/agents/reconcile", {
      method: "POST",
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { isAdmin: boolean }).toMatchObject({
      isAdmin: true,
    });
  });
});

describe("createAdminAuthMiddleware — account-scoped callers (SSP-2.1)", () => {
  function buildAccountApp() {
    const app = new Hono<AdminAuthEnv>();
    app.use(
      "*",
      createAdminAuthMiddleware({
        sessionSecret: SESSION_SECRET,
        agentTokenService: { validate: async () => null },
        callerScopeResolver: createCallerScopeResolver(
          {
            getAccountIdByEmail: async (e) =>
              e === "a@example.com" ? "acct-a" : null,
            listAgentIdsByAccount: async (id) =>
              id === "acct-a" ? ["agent-in-a"] : [],
            listMemberAgentIds: async () => [],
          },
          true,
        ),
      }),
    );
    app.all("*", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows an account member on their account's agent", async () => {
    const jwt = await makeMemberJwt("a@example.com");
    const res = await buildAccountApp().request("/agents/agent-in-a/envs", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it("denies the same caller on another account's agent", async () => {
    const jwt = await makeMemberJwt("a@example.com");
    const res = await buildAccountApp().request("/agents/agent-in-b/envs", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("extractAgentId", () => {
  it("returns the first segment after /agents/", () => {
    expect(extractAgentId("/agents/abc/crons/x")).toBe("abc");
    expect(extractAgentId("/agents/abc")).toBe("abc");
  });

  it("returns null when there is no agent segment", () => {
    expect(extractAgentId("/agents")).toBeNull();
    expect(extractAgentId("/other/abc")).toBeNull();
  });
});

// ─── Platform scopes (COS-28.1) ──────────────────────────────────────────────

describe("parseAdminApiKeys — platform scopes", () => {
  it("parses svc:tok:platform.read with scope platform.read and token tok", () => {
    const keys = parseAdminApiKeys("svc:tok:platform.read");
    expect(keys.get("tok")).toEqual({ name: "svc", scope: "platform.read" });
  });

  it("parses platform.ops", () => {
    expect(parseAdminApiKeys("ops:tok2:platform.ops").get("tok2")?.scope).toBe(
      "platform.ops",
    );
  });
});

describe("createAdminAuthMiddleware — platform scopes", () => {
  const READ = "read-token";
  const OPS = "ops-token";

  function buildPlatformApp(): Hono<AdminAuthEnv> {
    const app = buildApp(
      async () => null,
      parseAdminApiKeys(`r:${READ}:platform.read,o:${OPS}:platform.ops`),
    );
    app.patch("/agents/:id", (c) => {
      requireScope(c, "ops");
      return c.json({ scope: c.get("scope"), isAdmin: c.get("isAdmin") });
    });
    app.delete("/agents/:id", (c) => c.json({ ok: true }));
    app.patch("/agents/:id/envs", (c) => c.json({ ok: true }));
    app.get("/agents", (c) => c.json({ scope: c.get("scope") }));
    return app;
  }

  const call = (
    app: Hono<AdminAuthEnv>,
    token: string,
    method: string,
    path: string,
  ) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

  it("platform.read: 200 on GET /agents, scope kind platform-read, isAdmin false", async () => {
    const res = await call(buildPlatformApp(), READ, "GET", "/agents");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: unknown }).scope).toEqual({
      kind: "platform-read",
    });
  });

  it("platform.read: 200 on GET of an agent-scoped route", async () => {
    const res = await call(
      buildPlatformApp(),
      READ,
      "GET",
      `/agents/${AGENT_ID}/envs`,
    );
    expect(res.status).toBe(200);
  });

  it("platform.read: 403 on PATCH /agents/{id}", async () => {
    const res = await call(
      buildPlatformApp(),
      READ,
      "PATCH",
      `/agents/${AGENT_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it("platform.ops: 200 on PATCH /agents/{id} with isAdmin false and scope platform-ops", async () => {
    const res = await call(
      buildPlatformApp(),
      OPS,
      "PATCH",
      `/agents/${AGENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scope: { kind: "platform-ops" },
      isAdmin: false,
    });
  });

  it("platform.ops: 403 on PATCH /agents/{id}/envs and DELETE /agents/{id}", async () => {
    const app = buildPlatformApp();
    expect(
      (await call(app, OPS, "PATCH", `/agents/${AGENT_ID}/envs`)).status,
    ).toBe(403);
    expect((await call(app, OPS, "DELETE", `/agents/${AGENT_ID}`)).status).toBe(
      403,
    );
  });

  it("platform.ops: subpath entries match deeper paths but not look-alike prefixes", async () => {
    const app = buildApp(
      async () => null,
      parseAdminApiKeys(`o:${OPS}:platform.ops`),
    );
    app.delete("/agents/:id/repos/:repo", (c) => c.json({ ok: true }));
    app.delete("/agents/:id/reposx", (c) => c.json({ ok: true }));
    expect(
      (await call(app, OPS, "DELETE", `/agents/${AGENT_ID}/repos/r`)).status,
    ).toBe(200);
    expect(
      (await call(app, OPS, "DELETE", `/agents/${AGENT_ID}/reposx`)).status,
    ).toBe(403);
  });

  it("agent and admin keys get scope kinds agent / admin", async () => {
    const app = buildApp(
      async () => null,
      parseAdminApiKeys(`a:adm:*,s:svc:${AGENT_ID}`),
    );
    app.get("/who", (c) => c.json(c.get("scope")));
    expect(await (await call(app, "adm", "GET", "/who")).json()).toEqual({
      kind: "admin",
    });
    expect(await (await call(app, "svc", "GET", "/who")).json()).toEqual({
      kind: "agent",
      agentId: AGENT_ID,
    });
  });

  it("PLATFORM_OPS_ROUTES lists the allowlisted mutating routes", () => {
    expect(PLATFORM_OPS_ROUTES.map((r) => `${r.method} ${r.path}`)).toContain(
      "PATCH /agents/{id}",
    );
  });
});
