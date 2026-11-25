/**
 * admin/src/github-sync-switch.integration.test.ts
 * GIS-1.2: apply ordering for an "all" installation against the recorded
 * enterprise cassette (real GithubEnterpriseClient, fetch replaced by the
 * recording) with the real cache and a real GitHubReconcileAudit row.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../prisma/client/client.ts";
import { GithubSyncService } from "./github-sync.ts";
import { lazyInstallerClient } from "./github-installation-wiring.ts";
import { GitHubRepoCacheService } from "./github-repo-cache.ts";
import { DEPLOYMENT_WIDE_ACCOUNT_KEY } from "./github-agent-installation-crawler.ts";
import {
  createInstallationPort,
  PrismaInstallationAudit,
} from "./installation-ports.ts";
import { createInstallationReposPort } from "./installation-repos-service.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const cassette = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-enterprise-cassette.json", import.meta.url)
      .pathname,
    "utf-8",
  ),
) as Record<string, { status: number; body: unknown }>;

const INST = "/enterprises/acme/apps/organizations/acme-eng/installations";
const APP_ID = 777;
const AGENT_ID = "gis-it-agent";
const ORG = "acme-eng";
const REPOS = ["acme-eng/repo-1", "acme-eng/repo-2"];

function routeTable(selection: string): Record<string, string> {
  return {
    "GET /enterprises/acme/installation": "enterprise_installation_success",
    "POST /app/installations/4242/access_tokens": "access_token_success",
    [`GET ${INST}`]: selection,
    [`GET ${INST}/501/repositories`]: "install_repos_success",
    [`PATCH ${INST}/501/repositories`]: "install_selection_success",
    [`PATCH ${INST}/501/repositories/add`]: "install_repos_add_success",
    [`PATCH ${INST}/501/repositories/remove`]: "install_repos_remove_success",
  };
}

describeOrSkip("GitHub Sync all-to-selected switch (integration)", () => {
  let prisma: PrismaClient;
  let cache: GitHubRepoCacheService;
  const checkedAt = new Date(Date.now() - 60_000);

  const clean = async () => {
    await prisma.gitHubReconcileAudit.deleteMany({ where: { agentId: AGENT_ID } });
    await prisma.gitHubRepoAccess.deleteMany({ where: { accountId: DEPLOYMENT_WIDE_ACCOUNT_KEY, org: ORG } });
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
  };

  async function seed(selection: "all" | "selected", repos: string[]) {
    const key = {
      accountId: DEPLOYMENT_WIDE_ACCOUNT_KEY,
      appKind: "agent" as const,
      appRef: String(APP_ID),
      org: ORG,
    };
    const snap = await cache.upsertSnapshot(key, {
      completedAt: checkedAt,
      totalCount: repos.length,
      repositorySelection: selection,
      lastError: null,
    });
    await cache.upsertRepos(
      snap.id,
      repos.map((fullName, i) => ({ githubId: i + 1, fullName })),
      checkedAt,
    );
    for (const full of REPOS) {
      await prisma.gitHubRepoAccess.upsert({
        where: {
          accountId_org_repo_username: {
            accountId: DEPLOYMENT_WIDE_ACCOUNT_KEY,
            org: ORG,
            repo: full.split("/")[1] as string,
            username: "dev",
          },
        },
        create: {
          accountId: DEPLOYMENT_WIDE_ACCOUNT_KEY,
          org: ORG,
          repo: full.split("/")[1] as string,
          username: "dev",
          canPush: full === "acme-eng/repo-1",
          level: full === "acme-eng/repo-1" ? "write" : "read",
          checkedAt,
          status: "ok",
        },
        update: {},
      });
    }
  }

  function service(requests: string[], patchBodies: unknown[]) {
    // The installation's repo list follows a landed selection switch.
    let installed = [...REPOS];
    const table = routeTable("org_installations_success");
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input.toString());
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      if (key === "GET /enterprises/acme/apps/installable_organizations") {
        return new Response(JSON.stringify([{ id: 5010, login: ORG }]), { status: 200 });
      }
      const name = table[key];
      if (!name) throw new Error(`no route for ${key}`);
      if (key.startsWith("PATCH") || key.startsWith("DELETE")) {
        requests.push(key);
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")));
      }
      const entry = cassette[name];
      if (!entry) throw new Error(`no cassette entry ${name}`);
      if (key === `GET ${INST}/501/repositories`) {
        return new Response(
          JSON.stringify(
            installed.map((full_name, i) => ({
              id: i + 1,
              name: full_name.split("/")[1],
              full_name,
            })),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (key === `PATCH ${INST}/501/repositories` && entry.status === 200) {
        installed = ((patchBodies.at(-1) as { repositories: string[] }).repositories).map(
          (n) => `${ORG}/${n}`,
        );
      }
      return new Response(JSON.stringify(entry.body), {
        status: entry.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = lazyInstallerClient({
      appService: {
        get: async () => ({ appId: 12345, enterpriseSlug: "acme" }) as never,
        getPrivateKey: async () => PEM,
      },
      fetchFn,
    });
    let repos = ["acme-eng/repo-2"];
    return new GithubSyncService({
      agents: {
        get: async () => ({
          id: AGENT_ID,
          githubUsername: "dev",
          appId: APP_ID,
          repos,
        }),
        setRepos: async (_id, next) => {
          requests.push("setRepos");
          repos = next;
        },
      },
      access: async () => {
        throw new Error("live resolver must not be used");
      },
      cache,
      lookupRepos: async () => [
        { org: ORG, completedAt: checkedAt, repos: REPOS },
      ],
      verifyPush: async (_u, repo) => repo === "acme-eng/repo-1",
      installation: createInstallationReposPort(createInstallationPort(client), client),
      audit: new PrismaInstallationAudit(prisma),
    });
  }

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    cache = new GitHubRepoCacheService(prisma);
    await clean();
  });
  afterEach(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it("switches first, folds the removal, writes the audit row; a later preview has nothing to do", async () => {
    await seed("all", REPOS);
    const requests: string[] = [];
    const bodies: unknown[] = [];
    const svc = service(requests, bodies);

    const before = await svc.preview(AGENT_ID);
    if (before.status !== "previewed") throw new Error(before.status);
    expect(before.plan.selectionSwitches).toEqual([
      { org: ORG, repos: ["acme-eng/repo-1"] },
    ]);
    expect(before.plan.appRemoves).toEqual(["acme-eng/repo-2"]);
    expect(requests).toEqual([]);

    const r = await svc.apply({
      agentId: AGENT_ID,
      caller: "root",
      appAdds: [],
      appRemoves: ["acme-eng/repo-2"],
      agentRemoves: ["acme-eng/repo-2"],
    });
    expect(r.status).toBe("applied");
    // PATCH selection (no /add or /remove: the removal is folded), then agent repos.
    expect(requests).toEqual([`PATCH ${INST}/501/repositories`, "setRepos"]);
    expect(bodies[0]).toEqual({
      repository_selection: "selected",
      repositories: ["repo-1"],
    });

    const rows = await prisma.gitHubReconcileAudit.findMany({
      where: { agentId: AGENT_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toEqual({ status: "applied" });
    expect(rows[0]?.diff).toMatchObject({
      installationRemoves: ["acme-eng/repo-2"],
      configRemoves: ["acme-eng/repo-2"],
      selectionSwitches: [{ org: ORG, repos: ["acme-eng/repo-1"] }],
    });

    // The next crawl records "selected" and the shrunk repo list.
    await prisma.gitHubCachedRepo.deleteMany();
    await prisma.gitHubRepoSnapshot.deleteMany();
    await seed("selected", ["acme-eng/repo-1"]);
    const after = await svc.preview(AGENT_ID);
    if (after.status !== "previewed") throw new Error(after.status);
    expect(after.plan.selectionSwitches).toEqual([]);
    expect([
      after.plan.appAdds,
      after.plan.appRemoves,
      after.plan.agentRemoves,
    ]).toEqual([[], [], []]);
  });

  it("records a failed audit row with nothing landed when GitHub answers 403", async () => {
    await seed("all", REPOS);
    const requests: string[] = [];
    const svc = service(requests, []);
    // Swap the recorded success for the recorded 403 on the PATCH.
    const original = cassette.install_selection_success;
    cassette.install_selection_success = cassette.install_selection_403 as never;
    try {
      const r = await svc.apply({
        agentId: AGENT_ID,
        caller: "root",
        appAdds: [],
        appRemoves: ["acme-eng/repo-2"],
        agentRemoves: [],
      });
      if (r.status !== "failed") throw new Error(r.status);
      expect(r.error).toContain("enterprise_organization_installation_repositories");
    } finally {
      cassette.install_selection_success = original as never;
    }
    expect(requests).toEqual([`PATCH ${INST}/501/repositories`]);
    const rows = await prisma.gitHubReconcileAudit.findMany({
      where: { agentId: AGENT_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toMatchObject({ status: "failed" });
    expect(rows[0]?.diff).toEqual({
      installationAdds: [],
      installationRemoves: [],
      configAdds: [],
      configRemoves: [],
    });
  });
});
