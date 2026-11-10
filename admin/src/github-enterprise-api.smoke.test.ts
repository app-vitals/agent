/**
 * admin/src/github-enterprise-api.smoke.test.ts
 * Smoke tests for the /github-enterprise admin routes via app.request(): every
 * route, auth, the private-App refusal and error mapping. In-memory app
 * service and a cassette-replaying fetchFn; no DB, no network.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAdminApiKeys } from "./api-auth.ts";
import { createGithubEnterpriseApp } from "./github-enterprise-api.ts";
import type {
  GitHubEnterpriseAppMetadata,
  GitHubEnterpriseAppRole,
  SaveGitHubEnterpriseAppInput,
} from "./github-enterprise-apps.ts";

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-enterprise-cassette.json", import.meta.url)
      .pathname,
    "utf-8",
  ),
);

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ADMIN = { Authorization: "Bearer tok-admin" };
const JSON_ADMIN = { ...ADMIN, "Content-Type": "application/json" };

function fakeAppService() {
  const rows = new Map<string, GitHubEnterpriseAppMetadata & { pem: string }>();
  const now = new Date("2026-11-09T12:00:00Z");
  return {
    rows,
    async list() {
      return [...rows.values()].map(({ pem: _p, ...m }) => m);
    },
    async get(role: GitHubEnterpriseAppRole) {
      const r = rows.get(role);
      if (!r) return null;
      const { pem: _p, ...m } = r;
      return m;
    },
    async save(input: SaveGitHubEnterpriseAppInput) {
      const row = {
        role: input.role,
        appId: input.appId,
        slug: input.slug,
        enterpriseSlug:
          input.role === "installer" ? (input.enterpriseSlug ?? null) : null,
        keySet: true,
        lastValidationStatus: null,
        lastValidatedAt: null,
        lastValidationError: null,
        createdAt: now,
        updatedAt: now,
        pem: input.privateKey,
      };
      rows.set(input.role, row);
      const { pem: _p, ...m } = row;
      return m;
    },
    async delete(role: GitHubEnterpriseAppRole) {
      rows.delete(role);
    },
    async getPrivateKey(role: GitHubEnterpriseAppRole) {
      return rows.get(role)?.pem ?? null;
    },
    async recordValidation(
      role: GitHubEnterpriseAppRole,
      r: { status: string; error?: string | null },
    ) {
      const row = rows.get(role);
      if (!row) return;
      row.lastValidationStatus = r.status;
      row.lastValidatedAt = now;
      row.lastValidationError = r.error ?? null;
    },
  };
}

function replayFetch(routes: Record<string, string>) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const base = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push(base);
    const key = routes[base];
    if (!key) throw new Error(`no route for ${base}`);
    const entry = cassette[key] as CassetteEntry;
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json", ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const ENT = "GET /enterprises/acme/installation";
const MINT = "POST /app/installations/4242/access_tokens";
const ORGS = "GET /enterprises/acme/apps/installable_organizations";
const INSTS = "GET /enterprises/acme/apps/organizations/org-1/installations";
const INSTALL = "POST /enterprises/acme/apps/organizations/org-1/installations";

function build(
  opts: {
    routes?: Record<string, string>;
    agents?: Record<string, Record<string, string> | null>;
  } = {},
) {
  const appService = fakeAppService();
  const { fetchFn, calls } = replayFetch({
    [ENT]: "enterprise_installation_success",
    [MINT]: "access_token_success",
    ...opts.routes,
  });
  const agents = opts.agents ?? {
    "agent-1": { GH_APP_SLUG: "example-agent-app" },
    "agent-noslug": { OTHER: "x" },
  };
  const app = createGithubEnterpriseApp({
    appService,
    agentService: {
      getSummary: async (id: string) =>
        id in agents
          ? ({
              id,
              name: id,
              selfHosted: false,
              specialty: "specialist",
            } as never)
          : null,
    },
    agentEnvService: {
      getByAgentId: async (id: string) =>
        agents[id] ? ({ env: agents[id] } as never) : null,
    },
    sessionSecret: "test-secret-32chars-for-ghe-api!!",
    adminApiKeys: parseAdminApiKeys(
      "root:tok-admin:*,ro:tok-read:platform.read,bot:tok-agent:agent-1",
    ),
    agentTokenService: { validate: async () => null },
    fetchFn,
    apiBase: "https://ghe.test",
  });
  return { app, appService, calls };
}

const installerBody = {
  appId: "12345",
  slug: "example-installer",
  enterpriseSlug: "acme",
  privateKey: PEM,
};

async function seed(h: ReturnType<typeof build>) {
  await h.appService.save({ role: "installer", ...installerBody });
}

describe("auth", () => {
  const cases: Array<[string, string, string]> = [
    ["GET", "/github-enterprise/apps", ""],
    ["PUT", "/github-enterprise/apps/installer", JSON.stringify(installerBody)],
    ["DELETE", "/github-enterprise/apps/installer", ""],
    ["POST", "/github-enterprise/apps/installer/validate", ""],
    ["GET", "/github-enterprise/orgs", ""],
    [
      "POST",
      "/github-enterprise/orgs/org-1/install",
      JSON.stringify({ agentId: "agent-1" }),
    ],
  ];
  it("rejects missing and unknown credentials with 401", async () => {
    const { app } = build();
    for (const [method, path, body] of cases) {
      const init = { method, ...(body ? { body } : {}) };
      expect((await app.request(path, init)).status).toBe(401);
      const bad = await app.request(path, {
        ...init,
        headers: { Authorization: "Bearer nope" },
      });
      expect(bad.status).toBe(401);
    }
  });
  it("rejects agent-scoped and platform.read callers with 403", async () => {
    const { app, calls } = build();
    for (const tok of ["tok-agent", "tok-read"]) {
      for (const [method, path, body] of cases) {
        const res = await app.request(path, {
          method,
          headers: {
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body } : {}),
        });
        expect(res.status).toBe(403);
      }
    }
    expect(calls).toEqual([]);
  });
});

describe("unconfigured deployment", () => {
  it("GET /apps reports unconfigured with no side effects", async () => {
    const { app, appService, calls } = build();
    const res = await app.request("/github-enterprise/apps", {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      installer: null,
      lookup: null,
    });
    expect(appService.rows.size).toBe(0);
    expect(calls).toEqual([]);
  });
  it("GET /orgs returns an empty unconfigured result without calling GitHub", async () => {
    const { app, calls } = build();
    const res = await app.request("/github-enterprise/orgs", {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, orgs: [] });
    expect(calls).toEqual([]);
  });
  it("validate and install refuse with 4xx and never call GitHub", async () => {
    const { app, calls } = build();
    const v = await app.request("/github-enterprise/apps/installer/validate", {
      method: "POST",
      headers: ADMIN,
    });
    expect(v.status).toBe(404);
    const i = await app.request("/github-enterprise/orgs/org-1/install", {
      method: "POST",
      headers: JSON_ADMIN,
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    expect(i.status).toBe(409);
    expect(calls).toEqual([]);
  });
  it("DELETE of an absent role is a no-op 204", async () => {
    const { app } = build();
    const res = await app.request("/github-enterprise/apps/lookup", {
      method: "DELETE",
      headers: ADMIN,
    });
    expect(res.status).toBe(204);
  });
});

describe("PUT/GET/DELETE per role", () => {
  it("stores and returns metadata with keySet, never the key", async () => {
    const h = build();
    const put = await h.app.request("/github-enterprise/apps/installer", {
      method: "PUT",
      headers: JSON_ADMIN,
      body: JSON.stringify(installerBody),
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain("PRIVATE KEY");
    expect(JSON.parse(text)).toMatchObject({
      role: "installer",
      appId: "12345",
      slug: "example-installer",
      enterpriseSlug: "acme",
      keySet: true,
    });

    const status = await h.app.request("/github-enterprise/apps", {
      headers: ADMIN,
    });
    const st = await status.text();
    expect(st).not.toContain("PRIVATE KEY");
    const parsed = JSON.parse(st);
    expect(parsed.configured).toBe(true);
    expect(parsed.installer.keySet).toBe(true);
    expect(parsed.lookup).toBeNull();

    const del = await h.app.request("/github-enterprise/apps/installer", {
      method: "DELETE",
      headers: ADMIN,
    });
    expect(del.status).toBe(204);
    expect(h.appService.rows.size).toBe(0);
  });

  it("rejects bad input with 4xx and never echoes the key", async () => {
    const h = build();
    const put = (role: string, body: unknown) =>
      h.app.request(`/github-enterprise/apps/${role}`, {
        method: "PUT",
        headers: JSON_ADMIN,
        body: JSON.stringify(body),
      });
    expect((await put("bogus", installerBody)).status).toBe(400);
    expect(
      (await put("installer", { ...installerBody, enterpriseSlug: undefined }))
        .status,
    ).toBe(422);
    const bad = await put("installer", {
      ...installerBody,
      privateKey: "not-a-pem-SECRETVALUE",
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).not.toContain("SECRETVALUE");
    expect((await put("installer", { appId: "1" })).status).toBe(400);
    expect(h.appService.rows.size).toBe(0);
  });
});

describe("POST validate", () => {
  it("installer: valid when enterprise_organization_installations is granted", async () => {
    const h = build();
    await seed(h);
    const res = await h.app.request(
      "/github-enterprise/apps/installer/validate",
      { method: "POST", headers: ADMIN },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("ghs_cassette");
    expect(JSON.parse(text)).toMatchObject({
      role: "installer",
      ok: true,
      status: "valid",
      requiredPermission: "enterprise_organization_installations",
      error: null,
    });
    expect(h.appService.rows.get("installer")?.lastValidationStatus).toBe(
      "valid",
    );
  });

  it("installer: reports a missing permission and persists it", async () => {
    const h = build({
      routes: { [MINT]: "access_token_no_installer_permission" },
    });
    await seed(h);
    const res = await h.app.request(
      "/github-enterprise/apps/installer/validate",
      { method: "POST", headers: ADMIN },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      status: "missing_permission",
    });
    expect(h.appService.rows.get("installer")?.lastValidationStatus).toBe(
      "missing_permission",
    );
  });

  it("installer: GitHub errors are recorded as non-leaky failures", async () => {
    const h = build({ routes: { [ENT]: "enterprise_installation_403" } });
    await seed(h);
    const res = await h.app.request(
      "/github-enterprise/apps/installer/validate",
      { method: "POST", headers: ADMIN },
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: "error" });
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("Resource not accessible");
    expect(h.appService.rows.get("installer")?.lastValidationStatus).toBe(
      "error",
    );
  });

  it("lookup: checks metadata read via GET /app", async () => {
    const h = build({ routes: { "GET /app": "app_get_success" } });
    await h.appService.save({
      role: "lookup",
      appId: "555",
      slug: "example-lookup-app",
      privateKey: PEM,
    });
    const res = await h.app.request("/github-enterprise/apps/lookup/validate", {
      method: "POST",
      headers: ADMIN,
    });
    expect(await res.json()).toMatchObject({ ok: true, status: "valid" });

    const h2 = build({ routes: { "GET /app": "app_get_no_metadata" } });
    await h2.appService.save({
      role: "lookup",
      appId: "555",
      slug: "example-lookup-app",
      privateKey: PEM,
    });
    const res2 = await h2.app.request(
      "/github-enterprise/apps/lookup/validate",
      { method: "POST", headers: ADMIN },
    );
    expect(await res2.json()).toMatchObject({
      ok: false,
      status: "missing_permission",
    });
  });
});

describe("GET orgs", () => {
  it("lists installable orgs with lookup and agent App installation flags", async () => {
    const h = build({
      routes: {
        [ORGS]: "installable_orgs_success",
        [INSTS]: "org_installations_success",
        "GET /enterprises/acme/apps/organizations/org-2/installations":
          "installable_orgs_empty",
      },
    });
    await seed(h);
    await h.appService.save({
      role: "lookup",
      appId: "555",
      slug: "example-lookup-app",
      privateKey: PEM,
    });
    const res = await h.app.request("/github-enterprise/orgs?agentId=agent-1", {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      agentAppSlug: string | null;
      orgs: Array<{
        login: string;
        lookupAppInstalled: boolean | null;
        agentAppInstalled: boolean | null;
      }>;
    };
    expect(body.configured).toBe(true);
    expect(body.agentAppSlug).toBe("example-agent-app");
    expect(body.orgs.map((o) => o.login)).toEqual(["org-1", "org-2"]);
    expect(body.orgs[1]).toMatchObject({
      lookupAppInstalled: false,
      agentAppInstalled: false,
    });
  });

  it("without agentId or lookup app the flags are null", async () => {
    const h = build({
      routes: {
        [ORGS]: "installable_orgs_success",
        [INSTS]: "installable_orgs_empty",
        "GET /enterprises/acme/apps/organizations/org-2/installations":
          "installable_orgs_empty",
      },
    });
    await seed(h);
    const res = await h.app.request("/github-enterprise/orgs", {
      headers: ADMIN,
    });
    const body = (await res.json()) as { orgs: Array<Record<string, unknown>> };
    expect(body.orgs[0]).toMatchObject({
      lookupAppInstalled: null,
      agentAppInstalled: null,
    });
  });

  it("404 for an unknown agentId", async () => {
    const h = build({ routes: { [ORGS]: "installable_orgs_empty" } });
    await seed(h);
    const res = await h.app.request("/github-enterprise/orgs?agentId=nope", {
      headers: ADMIN,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST install", () => {
  const post = (h: ReturnType<typeof build>, body: unknown, org = "org-1") =>
    h.app.request(`/github-enterprise/orgs/${org}/install`, {
      method: "POST",
      headers: JSON_ADMIN,
      body: JSON.stringify(body),
    });

  it("resolves the client id from the agent's slug and installs", async () => {
    const h = build({
      routes: {
        "GET /apps/example-agent-app": "public_app_success",
        [INSTALL]: "install_created",
      },
    });
    await seed(h);
    const res = await post(h, { agentId: "agent-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: true,
      org: "org-1",
      installation: { id: 601 },
    });
    expect(h.calls).toContain(INSTALL);
  });

  it("refuses a private App (public lookup 404) with a clear 422", async () => {
    const h = build({
      routes: { "GET /apps/example-agent-app": "public_app_private_404" },
    });
    await seed(h);
    const res = await post(h, { agentId: "agent-1" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/private/i);
    expect(h.calls).not.toContain(INSTALL);
  });

  it("refuses an App with no client id", async () => {
    const h = build({
      routes: { "GET /apps/example-agent-app": "public_app_no_client_id" },
    });
    await seed(h);
    expect((await post(h, { agentId: "agent-1" })).status).toBe(422);
  });

  it("refuses an agent with no GH_APP_SLUG, and an unknown agent", async () => {
    const h = build();
    await seed(h);
    const res = await post(h, { agentId: "agent-noslug" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /GH_APP_SLUG/,
    );
    expect((await post(h, { agentId: "ghost" })).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it("rejects an invalid stored slug before any outbound call", async () => {
    const h = build({ agents: { a: { GH_APP_SLUG: "../evil" } } });
    await seed(h);
    expect((await post(h, { agentId: "a" })).status).toBe(422);
    expect(h.calls).toEqual([]);
  });

  it("validates the body and the org", async () => {
    const h = build();
    await seed(h);
    expect((await post(h, {})).status).toBe(400);
    expect((await post(h, { agentId: "agent-1" }, "bad_org!")).status).toBe(
      400,
    );
  });

  const MAPPED: Array<[string, number, RegExp]> = [
    ["install_403", 424, /permission/i],
    ["install_404", 404, /could not find/i],
    ["install_422", 422, /rejected/i],
    ["install_429", 429, /rate/i],
    ["install_500", 502, /unavailable|error/i],
  ];
  for (const [key, status, msg] of MAPPED) {
    it(`maps GitHub ${key} to ${status} without leaking`, async () => {
      const h = build({
        routes: {
          "GET /apps/example-agent-app": "public_app_success",
          [INSTALL]: key,
        },
      });
      await seed(h);
      const res = await post(h, { agentId: "agent-1" });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text).error).toMatch(msg);
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("ghs_cassette");
      expect(text).not.toContain("Resource not accessible");
      expect(text).not.toContain("documentation_url");
    });
  }

  it("secondary rate limit 403 maps to 429", async () => {
    const h = build({
      routes: {
        "GET /apps/example-agent-app": "public_app_success",
        [INSTALL]: "install_403_secondary_rate_limit",
      },
    });
    await seed(h);
    expect((await post(h, { agentId: "agent-1" })).status).toBe(429);
  });
});
