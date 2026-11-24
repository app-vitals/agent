import { describe, expect, it } from "bun:test";
import {
  accessFor,
  envWith,
  fakePrisma,
  freshCache,
} from "./github-installation.fixtures.ts";
import {
  createGithubInstallationRepos,
  createGithubSync,
} from "./github-installation-wiring.ts";
import type { InstallationReposPort } from "./installation-repos-service.ts";

// Sync preview over the real cache service (fake prisma): complete, partial, stale.

const REPOS = ["acme/a", "acme/b", "acme/c"];
const PUSHABLE = ["acme/a"];
const HOUR = 3_600_000;

const port: InstallationReposPort = {
  listRepos: async () => ({ acme: REPOS }),
  listInstalled: async () => ({
    status: "found",
    orgs: [{ org: "acme", repos: REPOS }],
  }),
  addRepos: async () => {},
  removeRepos: async () => {},
};

function preview(cache: ReturnType<typeof freshCache>, now = new Date()) {
  const { prisma } = fakePrisma(REPOS, cache);
  const svc = createGithubSync({
    prisma,
    appService: { get: async () => null, getPrivateKey: async () => null },
    access: accessFor([]), // the live resolver must not be consulted
    agentEnv: envWith({ GH_APP_ID: "42" }),
    installationRepos: port,
    now: () => now,
    syncOverrides: {
      lookupRepos: async () => [
        {
          org: "acme",
          completedAt: new Date(now.getTime() - 1000),
          repos: REPOS,
        },
      ],
    },
  });
  return svc.preview("a1");
}

describe("sync preview over the cache", () => {
  it("proposes removals from a complete, fresh org", async () => {
    const now = new Date();
    const r = await preview(freshCache("acme", REPOS, PUSHABLE, now), now);
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.appRemoves).toEqual(["acme/b", "acme/c"]);
    expect(r.plan.skippedOrgs).toEqual([]);
  });

  it("skips a partial org (a repo has no ok row) and says it is incomplete", async () => {
    const now = new Date();
    const cache = freshCache("acme", REPOS, PUSHABLE, now);
    cache.access = (cache.access as { repo: string }[]).filter(
      (r) => r.repo !== "c",
    );
    const r = await preview(cache, now);
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.removedRepos).toEqual([]);
    expect(r.plan.skippedOrgs).toMatchObject([
      { org: "acme", reason: "access data is incomplete" },
    ]);
  });

  it("skips an org whose crawl has not completed", async () => {
    const now = new Date();
    const cache = freshCache("acme", REPOS, PUSHABLE, now);
    (cache.snapshots as { completedAt: Date | null }[])[0]!.completedAt = null;
    const r = await preview(cache, now);
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.removedRepos).toEqual([]);
    expect(r.plan.skippedOrgs[0]?.reason).toBe("access data is incomplete");
  });

  it("skips a stale org and reports when it was checked", async () => {
    const now = new Date();
    const checked = new Date(now.getTime() - 7 * HOUR);
    const r = await preview(freshCache("acme", REPOS, PUSHABLE, checked), now);
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.removedRepos).toEqual([]);
    expect(r.plan.skippedOrgs[0]?.reason).toBe(
      `access data is stale (checked ${checked.toISOString()})`,
    );
    expect(r.warnings.join()).toContain("stale");
  });

  it("an errored access row makes the org incomplete, never 'no access'", async () => {
    const now = new Date();
    const cache = freshCache("acme", REPOS, PUSHABLE, now);
    (cache.access as { repo: string; status: string }[])[1]!.status = "error";
    const r = await preview(cache, now);
    if (r.status !== "previewed") throw new Error(r.status);
    expect(r.plan.removedRepos).toEqual([]);
  });
});

describe("installation list access detail", () => {
  it("adds checkedAt, attempts and last error per repo", async () => {
    const now = new Date("2026-11-21T00:00:00.000Z");
    const cache = freshCache("acme", REPOS, PUSHABLE, now);
    Object.assign((cache.access as Record<string, unknown>[])[1] as object, {
      status: "error",
      attempts: 2,
      lastError: "boom",
    });
    const { prisma } = fakePrisma(REPOS, cache);
    const svc = createGithubInstallationRepos({
      prisma,
      appService: { get: async () => null, getPrivateKey: async () => null },
      access: accessFor([]),
      agentEnv: envWith({ GH_APP_ID: "42" }),
      installationRepos: port,
    });
    const r = await svc.list("a1");
    if (r.status !== "ok") throw new Error(r.status);
    const repos = r.orgs[0]?.repos ?? [];
    expect(repos[0]?.accessCheckedAt).toBe(now.toISOString());
    expect(repos[1]).toMatchObject({
      accessAttempts: 2,
      accessError: "boom",
    });
    expect(repos[1]?.userCanPush).toBeUndefined();
  });
});
