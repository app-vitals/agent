/**
 * admin/src/github-enterprise-api.integration.test.ts
 * Integration tests for the /github-enterprise routes against a real
 * PostgreSQL DB and the GHE-1.2 cassettes (replayed through an injected
 * fetchFn): the validate flow end to end, plus the isolation guarantee that
 * no agent-facing path can return a stored key.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentService } from "./agents.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { parseAdminApiKeys } from "./api-auth.ts";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AdminUIEnv } from "./admin-ui.ts";
import { registerAdminGithubEnterpriseRoutes } from "./admin-ui-github-enterprise.ts";
import { createGithubEnterpriseApp } from "./github-enterprise-api.ts";
import { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { identityCrypto, makeStrictTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const cassette: Record<
  string,
  { status: number; headers?: Record<string, string>; body: unknown }
> = JSON.parse(
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
const PEM_BODY = PEM.split("\n")[1] as string;
const ENC_KEY = "c".repeat(64);
const ADMIN = { Authorization: "Bearer tok-admin" };

function replay(routes: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const key = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    if (!key) throw new Error(`no route for ${init?.method} ${u.pathname}`);
    const e = cassette[key];
    return new Response(JSON.stringify(e?.body), {
      status: e?.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describeOrSkip("github-enterprise API (integration)", () => {
  let prisma: PrismaClient;
  let appService: GitHubEnterpriseAppService;

  const build = (routes: Record<string, string> = {}) =>
    createGithubEnterpriseApp({
      appService,
      agentService: new AgentService(prisma),
      agentEnvService: new AgentEnvService(prisma, identityCrypto),
      sessionSecret: "test-secret-32chars-for-ghe-api!!",
      adminApiKeys: parseAdminApiKeys("root:tok-admin:*"),
      agentTokenService: { validate: async () => null },
      fetchFn: replay({
        "GET /enterprises/acme/installation": "enterprise_installation_success",
        "POST /app/installations/4242/access_tokens": "access_token_success",
        ...routes,
      }),
      apiBase: "https://ghe.test",
      now: () => new Date("2026-11-09T12:00:00Z"),
    });

  const put = (app: ReturnType<typeof build>) =>
    app.request("/github-enterprise/apps/installer", {
      method: "PUT",
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        slug: "example-installer",
        enterpriseSlug: "acme",
        privateKey: PEM,
      }),
    });

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.gitHubEnterpriseApp.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agent.deleteMany();
    appService = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(ENC_KEY),
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("unconfigured: status is empty and nothing is written", async () => {
    const app = build();
    const res = await app.request("/github-enterprise/apps", {
      headers: ADMIN,
    });
    expect(await res.json()).toEqual({
      configured: false,
      installer: null,
      lookup: null,
    });
    expect(await prisma.gitHubEnterpriseApp.count()).toBe(0);
  });

  it("a .pem upload through the settings UI saves the same row as pasting", async () => {
    const api = build();
    const ui = new Hono<AdminUIEnv>();
    registerAdminGithubEnterpriseRoutes(ui, {
      requireAuth: (async (c, next) => {
        c.set("userEmail", "admin@x.com");
        c.set("isAdmin", true);
        await next();
      }) as MiddlewareHandler<AdminUIEnv>,
      html: (content, o) => new Response(content, { status: o?.status ?? 200 }),
      api: (path, init) =>
        api.request(path, {
          ...init,
          headers: { ...(init?.headers ?? {}), ...ADMIN },
        }),
    });
    const base = "/admin/settings/github-enterprise/apps/lookup";
    const fields = { appId: "777", slug: "example-lookup" };
    const snapshot = async () => {
      const row = await prisma.gitHubEnterpriseApp.findUnique({
        where: { role: "lookup" },
      });
      return {
        appId: row?.appId,
        slug: row?.slug,
        enterpriseSlug: row?.enterpriseSlug,
        key: await appService.getPrivateKey("lookup"),
      };
    };

    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    body.set("privateKey", PEM);
    expect((await ui.request(base, { method: "POST", body })).status).toBe(302);
    const pasted = await snapshot();

    await prisma.gitHubEnterpriseApp.deleteMany();
    const upload = new FormData();
    for (const [k, v] of Object.entries(fields)) upload.set(k, v);
    upload.set("privateKeyFile", new File([PEM], "key.pem"));
    const res = await ui.request(base, { method: "POST", body: upload });
    expect(res.status).toBe(302);
    expect(await snapshot()).toEqual({
      ...pasted,
      key: (pasted.key ?? "").trim(),
    });
    const row = await prisma.gitHubEnterpriseApp.findUnique({
      where: { role: "lookup" },
    });
    expect(row?.privateKeyEncrypted).not.toContain(PEM_BODY);
  });

  it("PUT then validate persists the result; the key is encrypted and never returned", async () => {
    const app = build();
    const saved = await put(app);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(PEM_BODY);

    const res = await app.request(
      "/github-enterprise/apps/installer/validate",
      {
        method: "POST",
        headers: ADMIN,
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PEM_BODY);
    expect(text).not.toContain("ghs_cassette");
    expect(JSON.parse(text)).toMatchObject({ ok: true, status: "valid" });

    const row = await prisma.gitHubEnterpriseApp.findUnique({
      where: { role: "installer" },
    });
    expect(row?.lastValidationStatus).toBe("valid");
    expect(row?.lastValidatedAt).toBeInstanceOf(Date);
    expect(row?.privateKeyEncrypted).not.toContain(PEM_BODY);

    const status = await app.request("/github-enterprise/apps", {
      headers: ADMIN,
    });
    const st = await status.text();
    expect(st).not.toContain(PEM_BODY);
    expect(st).not.toContain(row?.privateKeyEncrypted as string);
    expect(JSON.parse(st).installer.lastValidationStatus).toBe("valid");
  });

  it("validate against a cassette 403 records an error status", async () => {
    const app = build({
      "GET /enterprises/acme/installation": "enterprise_installation_403",
    });
    await put(app);
    const res = await app.request(
      "/github-enterprise/apps/installer/validate",
      {
        method: "POST",
        headers: ADMIN,
      },
    );
    expect(await res.json()).toMatchObject({ ok: false, status: "error" });
    const row = await prisma.gitHubEnterpriseApp.findUnique({
      where: { role: "installer" },
    });
    expect(row?.lastValidationStatus).toBe("error");
    expect(row?.lastValidationError).not.toContain("Resource not accessible");
  });

  it("PUT without SHIPWRIGHT_ENCRYPTION_KEY is refused with 422 and stores nothing", async () => {
    appService = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(undefined),
    );
    const res = await put(build());
    expect(res.status).toBe(422);
    expect(await prisma.gitHubEnterpriseApp.count()).toBe(0);
  });

  it("install resolves the agent's slug from its stored env against the cassettes", async () => {
    const agent = await prisma.agent.create({ data: { name: "Ghe Agent" } });
    await new AgentEnvService(prisma, identityCrypto).upsert(agent.id, {
      GH_APP_SLUG: "example-agent-app",
    });
    const app = build({
      "GET /apps/example-agent-app": "public_app_success",
      "POST /enterprises/acme/apps/organizations/org-1/installations":
        "install_created",
    });
    await put(app);
    const res = await app.request("/github-enterprise/orgs/org-1/install", {
      method: "POST",
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, org: "org-1" });
  });

  it("install prefers the stored GH_APP_CLIENT_ID and skips the public lookup", async () => {
    const agent = await prisma.agent.create({ data: { name: "Ghe Agent" } });
    await new AgentEnvService(prisma, identityCrypto).upsert(agent.id, {
      GH_APP_SLUG: "example-agent-app",
      GH_APP_CLIENT_ID: "Iv1.targetapp0001",
    });
    // No "GET /apps/..." route: a public lookup would throw.
    const app = build({
      "POST /enterprises/acme/apps/organizations/org-1/installations":
        "install_created",
    });
    await put(app);
    const res = await app.request("/github-enterprise/orgs/org-1/install", {
      method: "POST",
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, org: "org-1" });
  });

  it("install refuses a private App when no client id is stored", async () => {
    const agent = await prisma.agent.create({ data: { name: "Ghe Agent" } });
    await new AgentEnvService(prisma, identityCrypto).upsert(agent.id, {
      GH_APP_SLUG: "example-agent-app",
    });
    const app = build({
      "GET /apps/example-agent-app": "public_app_private_404",
    });
    await put(app);
    const res = await app.request("/github-enterprise/orgs/org-1/install", {
      method: "POST",
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/private/i);
  });

  it("isolation: no agent-facing path returns the stored key", async () => {
    const agent = await prisma.agent.create({ data: { name: "Iso Agent" } });
    const envService = new AgentEnvService(prisma, identityCrypto);
    await envService.upsert(agent.id, { GH_APP_SLUG: "example-agent-app" });
    await put(build());
    const row = await prisma.gitHubEnterpriseApp.findUnique({
      where: { role: "installer" },
    });
    const needles = [
      PEM_BODY,
      "PRIVATE KEY",
      row?.privateKeyEncrypted as string,
    ];

    const surfaces: unknown[] = [
      await envService.getConfigBundle(agent.id),
      await envService.getByAgentId(agent.id),
    ];
    const runtime = createAgentRuntimeApp({
      agentEnvService: envService,
      agentCronJobService: { list: async () => [] },
      agentService: new AgentService(prisma),
      agentPluginService: new AgentPluginService(prisma),
      adminApiKeys: parseAdminApiKeys(`agent-key:agent-tok:${agent.id}`),
      agentTokenService: { validate: async () => null },
      sessionSecret: "test-secret-32chars-for-ghe-api!!",
    });
    for (const path of [`/${agent.id}/config`, `/${agent.id}/crons`]) {
      const res = await runtime.request(path, {
        headers: { Authorization: "Bearer agent-tok" },
      });
      expect(res.status).toBe(200);
      surfaces.push(await res.text());
    }
    for (const surface of surfaces) {
      const text =
        typeof surface === "string" ? surface : JSON.stringify(surface);
      for (const needle of needles) expect(text).not.toContain(needle);
    }

    // The agent-bearer key cannot reach the key-bearing admin routes either.
    const app = createGithubEnterpriseApp({
      appService,
      agentService: new AgentService(prisma),
      agentEnvService: envService,
      sessionSecret: "test-secret-32chars-for-ghe-api!!",
      adminApiKeys: parseAdminApiKeys(`agent-key:agent-tok:${agent.id}`),
      agentTokenService: { validate: async () => null },
    });
    const denied = await app.request("/github-enterprise/apps", {
      headers: { Authorization: "Bearer agent-tok" },
    });
    expect(denied.status).toBe(403);
  });
});
