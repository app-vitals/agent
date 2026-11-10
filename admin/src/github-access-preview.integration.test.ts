/**
 * admin/src/github-access-preview.integration.test.ts
 * Integration tests for GET /agents/:id/github-access (GHE-2.4): the full
 * route against a real PostgreSQL DB (agents + stored enterprise Apps) and the
 * GHE-1.2 / GHE-2.2 cassettes, replayed through an injected fetchFn.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { sign } from "hono/jwt";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentService } from "./agents.ts";
import type { AdminDeps } from "./agents-api.ts";
import { createAdminApp } from "./agents-api.ts";
import { NoopChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { createGithubAccessPreview } from "./github-enterprise-api.ts";
import { GitHubEnterpriseAppService } from "./github-enterprise-apps.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type {
  SpecialtyType,
  SpecialtyTypeResolver,
} from "./specialty-types.ts";
import { makeStrictTokenCrypto, makeTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const REAL_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

async function makeSessionCookie(): Promise<string> {
  return sign(
    {
      isAdmin: true,
      userId: "user-123",
      email: "admin@example.com",
      name: "Admin User",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

const CODING_TYPE: SpecialtyType = {
  name: "coding",
  displayName: "Coding Agent",
  templatesDir: "workspace/",
  tools: ["Read", "Write", "Edit"],
  requiredEnv: [],
};

function fakeSpecialtyTypes(): SpecialtyTypeResolver {
  const byType: Record<string, SpecialtyType> = { coding: CODING_TYPE };
  return {
    getType(specialty: string): SpecialtyType {
      return byType[specialty] ?? (byType.coding as SpecialtyType);
    },
    tryGetType(specialty: string): SpecialtyType | undefined {
      return byType[specialty];
    },
    listTypes() {
      return Object.entries(byType).map(([name, manifest]) => ({
        name,
        displayName: manifest.displayName,
      }));
    },
  };
}

function makeDeps(prisma: PrismaClient): AdminDeps {
  const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
  const crypto = makeTokenCrypto();
  if (savedKey === undefined) {
    delete process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  } else {
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;
  }

  return {
    agentService: new AgentService(prisma),
    agentEnvService: new AgentEnvService(prisma, crypto),
    agentCronJobService: new AgentCronJobService(prisma),
    agentCronRunService: new AgentCronRunService(prisma),
    agentCronRunStatsService: new AgentCronRunStatsService(prisma),
    agentToolService: new AgentToolService(prisma),
    agentTokenService: new AgentTokenService(prisma),
    agentPluginService: new AgentPluginService(prisma),
    agentMemberService: new AgentMemberService(prisma),
    specialtyRegistry: fakeSpecialtyTypes(),
    agentChatTokenService: new AgentChatTokenService(prisma),
    agentGitHubInstallationsService: new AgentGitHubInstallationsService(
      prisma,
    ),
    prisma,
    provisioner: new NoopAgentProvisioner(),
    serviceIntegrations: [
      {
        name: "task-store",
        listTokensForAgent: async () => [],
        revokeToken: async () => {},
      },
    ],
    chatService: new NoopChatServiceProvisioningClient(),
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => crypto.decrypt(value),
    sessionSecret: SESSION_SECRET,
  };
}

type Cassette = Record<
  string,
  { status: number; headers?: Record<string, string>; body: unknown }
>;
const load = (f: string): Cassette =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url).pathname, "utf-8"),
  );
const enterprise = load("github-enterprise-cassette.json");
const lookup = load("github-lookup-cassette.json");

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_BODY = PEM.split("\n")[1] as string;
const ENC_KEY = "c".repeat(64);
const NOW = new Date("2026-11-09T12:00:00Z");

/** route -> [cassette, entry]. org-1 has the lookup App, org-2 does not. */
const ROUTES: Record<string, [Cassette, string]> = {
  "GET /enterprises/acme/installation": [
    enterprise,
    "enterprise_installation_success",
  ],
  "POST /app/installations/4242/access_tokens": [
    enterprise,
    "access_token_success",
  ],
  "GET /enterprises/acme/apps/installable_organizations": [
    enterprise,
    "installable_orgs_success",
  ],
  "GET /orgs/org-1/installation": [lookup, "org_installation_success"],
  "GET /orgs/org-2/installation": [lookup, "org_installation_404"],
  "POST /app/installations/7001/access_tokens": [
    lookup,
    "lookup_token_success",
  ],
  "GET /installation/repositories": [lookup, "repos_success"],
  "GET /users/octocat": [lookup, "user_success"],
  "GET /repos/org-1/api/collaborators/octocat/permission": [
    lookup,
    "permission_maintain",
  ],
  "GET /repos/org-1/web/collaborators/octocat/permission": [
    lookup,
    "permission_triage",
  ],
};

describeOrSkip("GET /agents/:id/github-access (integration)", () => {
  let prisma: PrismaClient;
  let cookie: string;
  let calls: string[];
  let logs: string[];

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.gitHubEnterpriseApp.deleteMany();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    cookie = await makeSessionCookie();
    calls = [];
    logs = [];
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    const hit = ROUTES[key];
    if (!hit) throw new Error(`no route for ${key}`);
    const e = hit[0][hit[1]];
    return new Response(JSON.stringify(e?.body), {
      status: e?.status,
      headers: { "Content-Type": "application/json", ...(e?.headers ?? {}) },
    });
  }) as typeof fetch;

  async function seedApps() {
    const svc = new GitHubEnterpriseAppService(
      prisma,
      makeStrictTokenCrypto(ENC_KEY),
    );
    await svc.save({
      role: "installer",
      appId: "12345",
      slug: "example-installer",
      enterpriseSlug: "acme",
      privateKey: PEM,
    });
    await svc.save({
      role: "lookup",
      appId: "555",
      slug: "example-lookup",
      enterpriseSlug: null,
      privateKey: PEM,
    });
    return svc;
  }

  function build(appService: GitHubEnterpriseAppService) {
    return createAdminApp({
      ...makeDeps(prisma),
      githubAccessPreview: createGithubAccessPreview({
        appService,
        fetchFn,
        apiBase: "https://ghe.test",
        now: () => NOW,
      }),
    });
  }

  const get = (app: ReturnType<typeof build>, id: string) =>
    app.request(`/agents/${id}/github-access`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });

  const svcNoApps = () =>
    new GitHubEnterpriseAppService(prisma, makeStrictTokenCrypto(ENC_KEY));

  it("returns the resolver output per org, with no key material anywhere", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", githubUsername: "octocat" },
    });
    const app = build(await seedApps());
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...a) => {
        logs.push(a.map(String).join(" "));
      }),
    );
    try {
      const res = await get(app, agent.id);
      expect(res.status).toBe(200);
      const text = await res.text();
      const json = JSON.parse(text);
      expect(json.status).toBe("ok");
      expect(json.access.complete).toBe(false); // org-2 has no lookup App
      expect(json.access.orgs).toEqual([
        {
          org: "org-1",
          status: "ok",
          repos: [
            { fullName: "acme-eng/api", level: "maintain", canPush: true },
            { fullName: "acme-eng/web", level: "triage", canPush: false },
          ],
          unresolved: 0,
        },
        {
          org: "org-2",
          status: "lookup_app_not_installed",
          repos: [],
          unresolved: 0,
        },
      ]);
      for (const out of [text, ...logs]) {
        expect(out).not.toContain(PEM_BODY);
        expect(out).not.toContain("BEGIN");
        expect(out).not.toMatch(/ghs_|"token"/);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("unconfigured: 200 status and no GitHub call", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", githubUsername: "octocat" },
    });
    const res = await get(build(svcNoApps()), agent.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unconfigured" });
    expect(calls).toEqual([]);
  });

  it("only one App configured is still unconfigured", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", githubUsername: "octocat" },
    });
    const svc = svcNoApps();
    await svc.save({
      role: "lookup",
      appId: "555",
      slug: "example-lookup",
      enterpriseSlug: null,
      privateKey: PEM,
    });
    const res = await get(build(svc), agent.id);
    expect(await res.json()).toEqual({ status: "unconfigured" });
    expect(calls).toEqual([]);
  });

  it("user_not_found when the user does not exist on GitHub", async () => {
    const agent = await prisma.agent.create({
      data: { name: "A", githubUsername: "octocat" },
    });
    const saved = ROUTES["GET /users/octocat"];
    ROUTES["GET /users/octocat"] = [lookup, "user_nonexistent"];
    try {
      const res = await get(build(await seedApps()), agent.id);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("user_not_found");
      expect(json.access.orgs).toEqual([]);
      expect(calls.some((c) => c.includes("/permission"))).toBe(false);
    } finally {
      ROUTES["GET /users/octocat"] = saved as [Cassette, string];
    }
  });

  it("404 for an unknown agent and 422 for an unbound one", async () => {
    const unbound = await prisma.agent.create({ data: { name: "U" } });
    const app = build(await seedApps());
    expect((await get(app, "no-such-agent")).status).toBe(404);
    expect((await get(app, unbound.id)).status).toBe(422);
    expect(calls).toEqual([]);
  });
});
