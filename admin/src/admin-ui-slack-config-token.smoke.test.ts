/**
 * admin/src/admin-ui-slack-config-token.smoke.test.ts
 * Smoke tests for /admin/settings/slack-config-token (SCT-3.1) via
 * app.request(), over an in-memory token service and a fake rotate client.
 * No DB, no network.
 */

import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import { registerAdminSlackConfigTokenRoutes } from "./admin-ui-slack-config-token.ts";
import type { CallerScope } from "./caller-scope.ts";
import type { SlackConfigTokenMetadata } from "./slack-config-token.ts";
import { SlackConfigTokenError } from "./slack-provisioning-client.ts";

const PASTED = "xoxe-1-PASTED-REFRESH-SECRET";
const NEW_REFRESH = "xoxe-1-ROTATED-REFRESH-SECRET";
const NEW_ACCESS = "xoxe-ROTATED-ACCESS-SECRET";
const SECRETS = [PASTED, NEW_REFRESH, NEW_ACCESS];
const now = new Date("2026-11-16T00:00:00Z");

interface Opts {
  isAdmin?: boolean;
  scope?: CallerScope;
  role?: "owner" | "member";
  encryption?: boolean;
  rotateFails?: string;
}

function setup(opts: Opts = {}) {
  const rows = new Map<string | null, SlackConfigTokenMetadata>();
  const saved: { accountId: string | null; refreshToken: string }[] = [];
  const rotateCalls: string[] = [];
  const forced: (string | null)[] = [];
  const meta = (accountId: string | null): SlackConfigTokenMetadata => ({
    id: `id-${accountId}`,
    accountId,
    refreshTokenSet: true,
    accessTokenSet: true,
    accessTokenExpiresAt: null,
    slackTeamId: "T1",
    slackUserId: "U1",
    lastRotatedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  const app = new Hono<AdminUIEnv>();
  const requireAuth = (async (c, next) => {
    c.set("userEmail", "u@x.com");
    c.set("isAdmin", opts.isAdmin ?? true);
    await next();
  }) as MiddlewareHandler<AdminUIEnv>;
  registerAdminSlackConfigTokenRoutes(app, {
    requireAuth,
    tokens: {
      get: async (id) => rows.get(id) ?? null,
      save: async (id, input) => {
        saved.push({ accountId: id, refreshToken: input.refreshToken });
        rows.set(id, meta(id));
        return meta(id);
      },
      clear: async (id) => {
        rows.delete(id);
      },
      getAccessToken: async (id) => {
        forced.push(id);
        return NEW_ACCESS;
      },
    },
    rotateClient: {
      rotateConfigToken: async (t) => {
        rotateCalls.push(t);
        if (opts.rotateFails) {
          throw new SlackConfigTokenError(opts.rotateFails, `bad ${t}`);
        }
        return {
          accessToken: NEW_ACCESS,
          refreshToken: NEW_REFRESH,
          teamId: "T1",
          userId: "U1",
          iat: 1,
          exp: 2,
        };
      },
    },
    encryptionConfigured: () => opts.encryption ?? true,
    callerScopeResolver: async () =>
      opts.scope ?? { kind: "scoped", accountId: null, agentIds: [] },
    members: {
      getByEmail: async () =>
        ({
          accountId: "acct-1",
          role: opts.role ?? "owner",
        }) as never,
    },
    accounts: {
      listWithCounts: async () =>
        [
          { id: "acct-1", name: "Acme" },
          { id: "acct-2", name: "Globex" },
        ] as never,
      getWithCounts: async (id: string) => ({ id, name: "Acme" }) as never,
    },
    html: (content, o) =>
      new Response(content, {
        status: o?.status ?? 200,
        headers: { "Content-Type": "text/html" },
      }),
  });
  return { app, rows, saved, rotateCalls, forced };
}

const BASE = "/admin/settings/slack-config-token";
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const owner: CallerScope = {
  kind: "scoped",
  accountId: "acct-1",
  agentIds: [],
};
const expectNoSecrets = (s: string) => {
  for (const secret of SECRETS) expect(s).not.toContain(secret);
};

describe("/admin/settings/slack-config-token smoke", () => {
  it("renders the page with the scope picker for an admin", async () => {
    const { app } = setup();
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Deployment-wide");
    expect(html).toContain("Acme");
    expect(html).toContain("Not configured");
  });

  it("admin saves the default row: validates by rotating, stores the rotated pair, no secrets in redirect or page", async () => {
    const { app, saved, rotateCalls } = setup();
    const res = await app.request(
      `${BASE}/save`,
      form({ accountId: "", refreshToken: PASTED }),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") as string;
    expectNoSecrets(loc);
    expect(rotateCalls).toEqual([PASTED]);
    expect(saved).toEqual([{ accountId: null, refreshToken: NEW_REFRESH }]);
    const html = await (await app.request(loc)).text();
    expectNoSecrets(html);
    expect(html).toContain("validated and saved");
    expect(html).toContain("T1 / U1");
  });

  it("admin can save another account's row", async () => {
    const { app, saved } = setup();
    const res = await app.request(
      `${BASE}/save`,
      form({ accountId: "acct-2", refreshToken: PASTED }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accountId=acct-2");
    expect(saved[0]?.accountId).toBe("acct-2");
  });

  it("invalid paste shows an error and stores nothing", async () => {
    const { app, saved, rotateCalls } = setup({
      rotateFails: "invalid_refresh_token",
    });
    const res = await app.request(
      `${BASE}/save`,
      form({ accountId: "", refreshToken: PASTED }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("invalid_refresh_token");
    expectNoSecrets(html);
    expect(saved).toHaveLength(0);
    expect(rotateCalls).toHaveLength(1);
  });

  it("a paste without the xoxe-1- prefix is refused before any Slack call", async () => {
    const { app, saved, rotateCalls } = setup();
    const res = await app.request(
      `${BASE}/save`,
      form({ accountId: "", refreshToken: "xoxb-not-a-config-token" }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("xoxe-1-");
    expect(saved).toHaveLength(0);
    expect(rotateCalls).toHaveLength(0);
  });

  it("refuses save with a clear message when the encryption key is unset", async () => {
    const { app, saved, rotateCalls } = setup({ encryption: false });
    const res = await app.request(
      `${BASE}/save`,
      form({ accountId: "", refreshToken: PASTED }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("SHIPWRIGHT_ENCRYPTION_KEY");
    expect(saved).toHaveLength(0);
    expect(rotateCalls).toHaveLength(0);
  });

  it("clear removes the row", async () => {
    const { app, rows } = setup();
    await app.request(
      `${BASE}/save`,
      form({ accountId: "", refreshToken: PASTED }),
    );
    expect(rows.has(null)).toBe(true);
    const res = await app.request(`${BASE}/clear`, form({ accountId: "" }));
    expect(res.status).toBe(302);
    expect(rows.has(null)).toBe(false);
  });

  it("rotate now forces a rotation and never exposes the access token", async () => {
    const { app, forced } = setup();
    const res = await app.request(
      `${BASE}/rotate`,
      form({ accountId: "acct-2" }),
    );
    expect(res.status).toBe(302);
    expect(forced).toEqual(["acct-2"]);
    expectNoSecrets(res.headers.get("location") as string);
  });

  it("account owner manages only their own account's row", async () => {
    const { app, saved } = setup({ isAdmin: false, scope: owner });
    const page = await app.request(BASE);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Acme");
    expect(html).not.toContain("Deployment-wide");
    const own = await app.request(
      `${BASE}/save`,
      form({ refreshToken: PASTED }),
    );
    expect(own.status).toBe(302);
    expect(saved[0]?.accountId).toBe("acct-1");
    const ownExplicit = await app.request(
      `${BASE}/save`,
      form({ accountId: "acct-1", refreshToken: PASTED }),
    );
    expect(ownExplicit.status).toBe(302);
  });

  it("owner gets 403 for another account and the deployment-wide row", async () => {
    const { app, saved, rotateCalls } = setup({ isAdmin: false, scope: owner });
    expect((await app.request(`${BASE}?accountId=acct-2`)).status).toBe(403);
    for (const path of ["save", "clear", "rotate"]) {
      const res = await app.request(
        `${BASE}/${path}`,
        form({ accountId: "acct-2", refreshToken: PASTED }),
      );
      expect(res.status).toBe(403);
    }
    expect(saved).toHaveLength(0);
    expect(rotateCalls).toHaveLength(0);
  });

  it("plain account members get 403 on GET and every action", async () => {
    const { app, saved } = setup({
      isAdmin: false,
      scope: owner,
      role: "member",
    });
    expect((await app.request(BASE)).status).toBe(403);
    for (const path of ["save", "clear", "rotate"]) {
      const res = await app.request(
        `${BASE}/${path}`,
        form({ accountId: "acct-1", refreshToken: PASTED }),
      );
      expect(res.status).toBe(403);
    }
    expect(saved).toHaveLength(0);
  });

  it("callers without an account get 403", async () => {
    const { app } = setup({ isAdmin: false });
    expect((await app.request(BASE)).status).toBe(403);
  });
});
