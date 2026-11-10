/**
 * admin/src/user-repo-access-resolver.unit.test.ts
 * Unit tests for UserRepoAccessResolver with in-memory ports (no network, no DB).
 */

import { describe, expect, it } from "bun:test";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import type { RepoRole } from "./github-lookup-client.ts";
import {
  canPushForRole,
  UserRepoAccessResolver,
  type LookupPort,
} from "./user-repo-access-resolver.ts";

const NOW = new Date("2026-11-09T12:00:00Z");
const err = (kind: ConstructorParameters<typeof GithubEnterpriseError>[0]) =>
  new GithubEnterpriseError(kind, `boom ${kind} ghs_secret`);

function repo(org: string, name: string) {
  return {
    id: 1,
    name,
    fullName: `${org}/${name}`,
    private: false,
    archived: false,
  };
}

interface FakeOpts {
  repos?: Record<string, string[]>;
  perm?: (owner: string, repo: string) => RepoRole | Error | Promise<RepoRole>;
  token?: Record<string, Error>;
  user?: Error;
}

function fake(o: FakeOpts = {}) {
  const repos = o.repos ?? { acme: ["a", "b", "c"] };
  const calls: string[] = [];
  const lookup: LookupPort = {
    async getOrgToken(org) {
      const e = o.token?.[org];
      if (e) throw e;
      return { token: "ghs_secret", expiresAt: "x", installationId: 1 };
    },
    async getUser(_org, login) {
      if (o.user) throw o.user;
      return { id: 1, login, type: "User" };
    },
    async listInstallationRepositories(org) {
      return (repos[org] ?? []).map((n) => repo(org, n));
    },
    async getCollaboratorPermission(owner, r) {
      calls.push(`${owner}/${r}`);
      const v = await (o.perm ?? (() => "write" as RepoRole))(owner, r);
      if (v instanceof Error) throw v;
      return v;
    },
  };
  const installer = {
    async listInstallableOrganizations() {
      return Object.keys(repos).map((login, id) => ({ id, login }));
    },
  };
  const resolver = new UserRepoAccessResolver({
    installer,
    lookup,
    now: () => NOW,
    concurrency: 1,
  });
  return { resolver, calls };
}

describe("canPushForRole", () => {
  const cases: Array<[RepoRole, boolean]> = [
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ];
  for (const [role, expected] of cases) {
    it(`${role} -> ${expected}`, () =>
      expect(canPushForRole(role)).toBe(expected));
  }
});

describe("unknown is never none", () => {
  it("a repo that errors is absent from resolved and counted unresolved", async () => {
    const { resolver } = fake({
      perm: (_o, r) => (r === "b" ? err("server") : "read"),
    });
    const res = await resolver.resolve("octocat");
    const org = res.orgs[0];
    expect(org.repos.map((r) => r.fullName)).toEqual(["acme/a", "acme/c"]);
    expect(org.repos.some((r) => r.level === "none")).toBe(false);
    expect(org.unresolved).toBe(1);
    expect(org.status).toBe("partial");
    expect(res.complete).toBe(false);
    expect(res.unresolved).toBe(1);
  });

  it("an unknown role (custom role error) is unresolved, not none", async () => {
    const { resolver } = fake({
      perm: (_o, r) => (r === "a" ? err("unexpected") : "write"),
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].repos.map((r) => r.fullName)).toEqual([
      "acme/b",
      "acme/c",
    ]);
    expect(res.orgs[0].unresolved).toBe(1);
  });

  it("an explicit none from GitHub is a resolved none (known, not unknown)", async () => {
    const { resolver } = fake({ perm: () => "none" });
    const res = await resolver.resolve("octocat");
    expect(
      res.orgs[0].repos.every((r) => r.level === "none" && !r.canPush),
    ).toBe(true);
    expect(res.complete).toBe(true);
  });

  it("all repos failing individually yields error, not an empty ok list", async () => {
    const { resolver } = fake({ perm: () => err("server") });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].status).toBe("error");
    expect(res.orgs[0].unresolved).toBe(3);
    expect(res.complete).toBe(false);
  });
});

describe("403/429 mapping rule", () => {
  it("mid-org 429 with some resolved -> partial, stops further calls", async () => {
    const { resolver, calls } = fake({
      perm: (_o, r) => (r === "b" ? err("rate_limit") : "admin"),
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].status).toBe("partial");
    expect(res.orgs[0].repos.map((r) => r.fullName)).toEqual(["acme/a"]);
    expect(res.orgs[0].unresolved).toBe(2);
    expect(calls).toEqual(["acme/a", "acme/b"]);
    expect(res.complete).toBe(false);
  });

  it("mid-org 403 with some resolved -> partial", async () => {
    const { resolver } = fake({
      perm: (_o, r) => (r === "c" ? err("permission") : "read"),
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].status).toBe("partial");
    expect(res.orgs[0].repos).toHaveLength(2);
  });

  it("429 with nothing resolved -> rate_limited; 403 with nothing resolved -> error", async () => {
    const a = await fake({ perm: () => err("rate_limit") }).resolver.resolve(
      "o",
    );
    expect(a.orgs[0].status).toBe("rate_limited");
    expect(a.orgs[0].unresolved).toBe(3);
    const b = await fake({ perm: () => err("permission") }).resolver.resolve(
      "o",
    );
    expect(b.orgs[0].status).toBe("error");
  });

  it("token mint: 404 -> lookup_app_not_installed, 429 -> rate_limited, 403 -> error", async () => {
    const r404 = await fake({
      token: { acme: err("not_found") },
    }).resolver.resolve("o");
    expect(r404.orgs[0].status).toBe("lookup_app_not_installed");
    const r429 = await fake({
      token: { acme: err("rate_limit") },
    }).resolver.resolve("o");
    expect(r429.orgs[0].status).toBe("rate_limited");
    const r403 = await fake({
      token: { acme: err("permission") },
    }).resolver.resolve("o");
    expect(r403.orgs[0].status).toBe("error");
    expect(r403.complete).toBe(false);
  });

  it("other orgs continue after one org is rate limited", async () => {
    const { resolver } = fake({
      repos: { acme: ["a"], beta: ["x"] },
      perm: (o) => (o === "acme" ? err("rate_limit") : "write"),
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs.map((o) => o.status)).toEqual(["rate_limited", "ok"]);
    expect(res.complete).toBe(false);
  });
});

describe("user check and bounds", () => {
  it("nonexistent user short-circuits with user_not_found and no repo calls", async () => {
    const { resolver, calls } = fake({ user: err("not_found") });
    const res = await resolver.resolve("ghost");
    expect(res.outcome).toBe("user_not_found");
    expect(res.orgs).toEqual([]);
    expect(res.complete).toBe(false);
    expect(calls).toEqual([]);
  });

  it("skips orgs without the lookup app when verifying the user", async () => {
    const { resolver } = fake({
      repos: { acme: ["a"], beta: ["x"] },
      token: { acme: err("not_found") },
    });
    const res = await resolver.resolve("octocat");
    expect(res.outcome).toBe("ok");
    expect(res.userVerified).toBe(true);
    expect(res.orgs.map((o) => o.status)).toEqual([
      "lookup_app_not_installed",
      "ok",
    ]);
  });

  it("a rate-limited user check proceeds unverified and is incomplete", async () => {
    const { resolver } = fake({ user: err("rate_limit") });
    const res = await resolver.resolve("octocat");
    expect(res.userVerified).toBe(false);
    expect(res.complete).toBe(false);
  });

  it("concurrency never exceeds the bound", async () => {
    let inflight = 0;
    let max = 0;
    const names = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const base = fake({
      repos: { acme: names },
      perm: async (): Promise<RepoRole> => {
        inflight++;
        max = Math.max(max, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return "write";
      },
    });
    const resolver = new UserRepoAccessResolver({
      installer: {
        listInstallableOrganizations: async () => [{ id: 1, login: "acme" }],
      },
      lookup: (base.resolver as unknown as { lookup: LookupPort }).lookup,
      now: () => NOW,
      concurrency: 3,
    });
    const res = await resolver.resolve("octocat");
    expect(res.complete).toBe(true);
    expect(res.orgs[0].repos).toHaveLength(12);
    expect(max).toBe(3);
  });

  it("defaults concurrency to 5", async () => {
    let inflight = 0;
    let max = 0;
    const base = fake({
      repos: { acme: Array.from({ length: 20 }, (_, i) => `r${i}`) },
      perm: async (): Promise<RepoRole> => {
        inflight++;
        max = Math.max(max, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return "read";
      },
    });
    const resolver = new UserRepoAccessResolver({
      installer: {
        listInstallableOrganizations: async () => [{ id: 1, login: "acme" }],
      },
      lookup: (base.resolver as unknown as { lookup: LookupPort }).lookup,
      now: () => NOW,
    });
    await resolver.resolve("octocat");
    expect(max).toBe(5);
  });

  it("never leaks tokens into output", async () => {
    const { resolver } = fake({ perm: () => err("server") });
    const res = await resolver.resolve("octocat");
    expect(JSON.stringify(res)).not.toContain("ghs_");
  });

  it("stamps checkedAt from the injected clock", async () => {
    const res = await fake().resolver.resolve("octocat");
    expect(res.checkedAt).toBe(NOW.toISOString());
  });
});
