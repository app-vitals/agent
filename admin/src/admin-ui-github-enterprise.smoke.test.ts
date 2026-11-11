/**
 * admin/src/admin-ui-github-enterprise.smoke.test.ts
 * Smoke tests for /admin/settings/github-enterprise (GHE-1.4) via
 * app.request(), backed by the real GHE-1.3 API app with an in-memory app
 * service and a stubbed fetch. No DB, no network.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AdminUIEnv, createAdminUIApp } from "./admin-ui.ts";
import { makeMockDeps, makeSessionCookie } from "./admin-ui.fixtures.ts";
import { registerAdminGithubEnterpriseRoutes } from "./admin-ui-github-enterprise.ts";
import { parseAdminApiKeys } from "./api-auth.ts";
import { createGithubEnterpriseApp } from "./github-enterprise-api.ts";
import type {
  GitHubEnterpriseAppMetadata,
  GitHubEnterpriseAppRole,
  SaveGitHubEnterpriseAppInput,
} from "./github-enterprise-apps.ts";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function fakeAppService() {
  const rows = new Map<string, GitHubEnterpriseAppMetadata & { pem: string }>();
  const now = new Date("2026-11-09T12:00:00Z");
  const strip = ({
    pem: _p,
    ...m
  }: GitHubEnterpriseAppMetadata & { pem: string }) => m;
  return {
    async list() {
      return [...rows.values()].map(strip);
    },
    async get(role: GitHubEnterpriseAppRole) {
      const r = rows.get(role);
      return r ? strip(r) : null;
    },
    async save(input: SaveGitHubEnterpriseAppInput) {
      const row = {
        role: input.role,
        appId: input.appId,
        slug: input.slug,
        enterpriseSlug: input.enterpriseSlug ?? null,
        keySet: true,
        lastValidationStatus: null,
        lastValidatedAt: null,
        lastValidationError: null,
        createdAt: now,
        updatedAt: now,
        pem: input.privateKey,
      } as GitHubEnterpriseAppMetadata & { pem: string };
      rows.set(input.role, row);
      return strip(row);
    },
    async delete(role: GitHubEnterpriseAppRole) {
      rows.delete(role);
    },
    async getPrivateKey(role: GitHubEnterpriseAppRole) {
      return rows.get(role)?.pem ?? null;
    },
    async recordValidation(
      role: GitHubEnterpriseAppRole,
      r: { status: string; error: string | null },
    ) {
      const row = rows.get(role);
      if (row) {
        row.lastValidationStatus = r.status;
        row.lastValidationError = r.error;
        row.lastValidatedAt = now;
      }
    },
  };
}

function setup(opts: { isAdmin?: boolean; fetchStatus?: number } = {}) {
  const appService = fakeAppService();
  const fetchCalls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const fail = opts.fetchStatus;
    if (fail) return new Response("{}", { status: fail });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/access_tokens"))
      return json({
        token: "t",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: { enterprise_organization_installations: "write" },
      });
    if (url.endsWith("/installation")) return json({ id: 1 });
    return json({});
  }) as unknown as typeof fetch;
  const api = createGithubEnterpriseApp({
    appService,
    agentService: { getSummary: async () => null } as never,
    agentEnvService: { getByAgentId: async () => null } as never,
    sessionSecret: "test-secret-32chars-for-ghe-api!!",
    adminApiKeys: parseAdminApiKeys("root:tok-admin:*"),
    agentTokenService: { validate: async () => null } as never,
    fetchFn,
  });
  const app = new Hono<AdminUIEnv>();
  registerAdminGithubEnterpriseRoutes(app, {
    requireAuth: (async (c, next) => {
      c.set("userEmail", "admin@x.com");
      c.set("isAdmin", opts.isAdmin ?? true);
      await next();
    }) as MiddlewareHandler<AdminUIEnv>,
    html: (content, o) =>
      new Response(content, {
        status: o?.status ?? 200,
        headers: { "Content-Type": "text/html" },
      }),
    // The UI calls the GHE-1.3 API with a server-held admin bearer.
    api: (path, init) =>
      api.request(path, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: "Bearer tok-admin",
        },
      }),
  });
  return { app, appService, fetchCalls };
}

const BASE = "/admin/settings/github-enterprise";
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

describe("GET /admin/settings/github-enterprise", () => {
  it("403s for a non-admin", async () => {
    const { app } = setup({ isAdmin: false });
    expect((await app.request(BASE)).status).toBe(403);
    expect((await app.request(`${BASE}/apps/lookup`, form({}))).status).toBe(
      403,
    );
  });

  it("renders the empty state when nothing is configured", async () => {
    const { app } = setup();
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("optional");
    expect(html).toContain("Installer app");
  });

  it("renders setup guidance on both cards and the enterprise notice", async () => {
    const { app } = setup();
    const html = await (await app.request(BASE)).text();
    expect(html).toContain("GitHub Enterprise Cloud enterprise is required");
    expect(html).not.toContain("exactly as before");
    expect(html.match(/gh-ent-steps/g)?.length).toBe(2);
    expect(html.match(/gh-ent-ignore/g)?.length).toBe(2);
  });
});

describe("form posts", () => {
  it("saves an app, then shows status without the key", async () => {
    const { app, appService } = setup();
    const res = await app.request(
      `${BASE}/apps/lookup`,
      form({ appId: "42", slug: "acme-lookup", privateKey: PEM }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(BASE);
    expect((await appService.get("lookup"))?.slug).toBe("acme-lookup");
    const html = await (await app.request(BASE)).text();
    expect(html).toContain("acme-lookup");
    expect(html).toContain("Key set");
    expect(html).not.toContain("PRIVATE KEY");
  });

  it("surfaces a typed error for an invalid key and does not echo it", async () => {
    const { app } = setup();
    const res = await app.request(
      `${BASE}/apps/lookup`,
      form({
        appId: "42",
        slug: "acme-lookup",
        privateKey: "not-a-pem-SECRET",
      }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("privateKey is not a valid PEM private key");
    expect(html).not.toContain("not-a-pem-SECRET");
  });

  it("surfaces validation errors for a missing installer enterprise slug", async () => {
    const { app } = setup();
    const res = await app.request(
      `${BASE}/apps/installer`,
      form({ appId: "42", slug: "acme-inst", privateKey: PEM }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("enterpriseSlug is required");
  });

  it("validates the installer and shows the persisted result", async () => {
    const { app } = setup();
    await app.request(
      `${BASE}/apps/installer`,
      form({
        appId: "42",
        slug: "acme-inst",
        enterpriseSlug: "acme",
        privateKey: PEM,
      }),
    );
    const res = await app.request(`${BASE}/apps/installer/validate`, form({}));
    expect(res.status).toBe(302);
    const html = await (await app.request(BASE)).text();
    expect(html).toContain("valid");
    expect(html).not.toContain("Not validated yet");
  });

  it("shows non-failing permission warnings on the card after validate", async () => {
    const { app } = setup();
    await app.request(
      `${BASE}/apps/installer`,
      form({
        appId: "42",
        slug: "acme-inst",
        enterpriseSlug: "acme",
        privateKey: PEM,
      }),
    );
    const res = await app.request(`${BASE}/apps/installer/validate`, form({}));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") as string;
    expect(loc).toContain("warn=installer_repositories_write");
    const html = await (await app.request(loc)).text();
    expect(html).toContain("enterprise_organization_installation_repositories");
    expect(html).toContain("gh-ent-warning");
  });

  it("validate on an unconfigured role is a readable 404 message", async () => {
    const { app } = setup();
    const res = await app.request(`${BASE}/apps/lookup/validate`, form({}));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no &#39;lookup&#39; App is configured");
  });

  it("deletes an app", async () => {
    const { app, appService } = setup();
    await app.request(
      `${BASE}/apps/lookup`,
      form({ appId: "42", slug: "acme-lookup", privateKey: PEM }),
    );
    const res = await app.request(`${BASE}/apps/lookup/delete`, form({}));
    expect(res.status).toBe(302);
    expect(await appService.get("lookup")).toBeNull();
  });

  it("rejects an unknown role", async () => {
    const { app } = setup();
    expect((await app.request(`${BASE}/apps/bogus`, form({}))).status).toBe(
      404,
    );
  });

  it("install without a configured installer surfaces the 409 message", async () => {
    const { app } = setup();
    const res = await app.request(
      `${BASE}/orgs/org-a/install`,
      form({ agentId: "agent-1" }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("the installer App is not configured");
  });

  it("install with an empty agent id is a readable 400", async () => {
    const { app } = setup();
    const res = await app.request(`${BASE}/orgs/org-a/install`, form({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Agent ID is required");
  });

  it("org list failure from GitHub renders a message, not a 500", async () => {
    const { app } = setup({ fetchStatus: 401 });
    await app.request(
      `${BASE}/apps/installer`,
      form({
        appId: "42",
        slug: "acme-inst",
        enterpriseSlug: "acme",
        privateKey: PEM,
      }),
    );
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "GitHub rejected the configured App credentials",
    );
  });
});

describe("nav entry in the full admin UI", () => {
  const api = async () =>
    new Response(
      JSON.stringify({ configured: false, installer: null, lookup: null }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  const NAV = 'href="/admin/settings/github-enterprise"';

  it("shows Settings to admins and serves the page", async () => {
    const app = createAdminUIApp(makeMockDeps({ githubEnterpriseApi: api }));
    const cookie = `admin_session=${await makeSessionCookie()}`;
    const nav = await (
      await app.request("/admin/agents", { headers: { cookie } })
    ).text();
    expect(nav).toContain(NAV);
    const page = await app.request(BASE, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("optional");
  });

  it("hides Settings and 403s the page for non-admins", async () => {
    const app = createAdminUIApp(makeMockDeps({ githubEnterpriseApi: api }));
    const cookie = `admin_session=${await makeSessionCookie(undefined, "u2", "other@example.com", false)}`;
    const nav = await app.request("/admin/agents", { headers: { cookie } });
    expect(await nav.text()).not.toContain(NAV);
    expect((await app.request(BASE, { headers: { cookie } })).status).toBe(403);
  });

  it("leaves nav and routes untouched when the API is not wired", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const cookie = `admin_session=${await makeSessionCookie()}`;
    const nav = await (
      await app.request("/admin/agents", { headers: { cookie } })
    ).text();
    expect(nav).not.toContain(NAV);
    expect((await app.request(BASE, { headers: { cookie } })).status).toBe(404);
  });
});
