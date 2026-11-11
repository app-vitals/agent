/**
 * admin/src/github-lookup-client.integration.test.ts
 * Integration tests for GithubLookupClient against hand-authored cassettes
 * (fixtures/github-lookup-cassette.json, derived from GitHub's REST OpenAPI
 * description; nothing was recorded live).
 *
 * Replays through an INJECTED fetchFn: no global.fetch override, no
 * mock.module(). The RSA key is generated in-test.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GithubEnterpriseErrorKind } from "./github-enterprise-client.ts";
import { GithubLookupClient, type RepoRole } from "./github-lookup-client.ts";

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-lookup-cassette.json", import.meta.url).pathname,
    "utf-8",
  ),
);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = new Date("2026-11-09T12:00:00Z");
const API = "https://ghe.test";
const INST = "GET /orgs/acme-eng/installation";
const MINT = "POST /app/installations/7001/access_tokens";
const REPOS = "GET /installation/repositories";
const PERM = "GET /repos/acme-eng/api/collaborators/octocat/permission";
const USER = "GET /users/octocat";
const MEMBER = "GET /orgs/acme-eng/members/octocat";

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
}

/** routes: "METHOD /path[?page=N]" or "METHOD /path" -> cassette key. */
function replay(routes: Record<string, string>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const method = init?.method ?? "GET";
    const page = u.searchParams.get("page");
    const base = `${method} ${u.pathname}`;
    calls.push({
      method,
      path: `${u.pathname}${u.search}`,
      headers: new Headers(init?.headers),
    });
    const key = (page && routes[`${base}?page=${page}`]) || routes[base];
    if (!key) throw new Error(`no route for ${base} page=${page}`);
    const entry = cassette[key];
    if (!entry) throw new Error(`cassette key not found: ${key}`);
    const bodyless = entry.status === 204 || entry.status === 302;
    return new Response(bodyless ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json", ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const OK = {
  [INST]: "org_installation_success",
  [MINT]: "lookup_token_success",
};

function makeClient(routes: Record<string, string>) {
  const { fetchFn, calls } = replay({ ...OK, ...routes });
  const client = new GithubLookupClient({
    appId: "555",
    privateKey,
    apiBase: API,
    fetchFn,
    now: () => NOW,
  });
  return { client, calls };
}

const ERRORS: Array<[string, GithubEnterpriseErrorKind, number]> = [
  ["403", "permission", 403],
  ["404", "not_found", 404],
  ["422", "validation", 422],
  ["429", "rate_limit", 429],
  ["500", "server", 500],
  ["503", "server", 503],
];

async function errOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as Error & {
      kind: GithubEnterpriseErrorKind;
      status?: number;
      retryAfterSeconds?: number;
    };
  }
  throw new Error("expected rejection");
}

function expectNoSecrets(e: Error) {
  expect(e.message).not.toContain("PRIVATE KEY");
  expect(e.message).not.toContain("ghs_lookup");
  expect(e.message).not.toContain("Bearer");
}

describe("getOrgToken", () => {
  it("looks up the org installation with a JWT then mints a token", async () => {
    const { client, calls } = makeClient({});
    expect(await client.getOrgToken("acme-eng")).toEqual({
      token: "ghs_lookupInstallationTokenSecret",
      expiresAt: "2026-11-09T13:00:00Z",
      installationId: 7001,
      repositorySelection: "all",
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([INST, MINT]);
    for (const c of calls) {
      expect(c.headers.get("authorization")).toMatch(
        /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
      );
    }
  });

  it("reports repository_selection selected from the installation", async () => {
    const { client } = makeClient({ [INST]: "org_installation_selected" });
    expect((await client.getOrgToken("acme-eng")).repositorySelection).toBe(
      "selected",
    );
  });

  it("caches per org until near expiry", async () => {
    const { client, calls } = makeClient({});
    await client.getOrgToken("acme-eng");
    await client.getOrgToken("ACME-ENG");
    expect(calls).toHaveLength(2);
  });

  for (const [suffix, kind, status] of ERRORS) {
    it(`maps installation lookup ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [INST]: `org_installation_${suffix}` });
      const e = await errOf(client.getOrgToken("acme-eng"));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });

    it(`maps token mint ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [MINT]: `lookup_token_${suffix}` });
      const e = await errOf(client.getOrgToken("acme-eng"));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
  }

  it("surfaces retry-after on 429", async () => {
    const { client } = makeClient({ [MINT]: "lookup_token_429" });
    expect(
      (await errOf(client.getOrgToken("acme-eng"))).retryAfterSeconds,
    ).toBe(30);
  });
});

describe("listInstallationRepositories", () => {
  it("lists a single page with the installation token", async () => {
    const { client, calls } = makeClient({ [REPOS]: "repos_success" });
    const repos = await client.listInstallationRepositories("acme-eng");
    expect(repos).toEqual([
      {
        id: 1,
        name: "api",
        fullName: "acme-eng/api",
        private: false,
        archived: false,
      },
      {
        id: 2,
        name: "web",
        fullName: "acme-eng/web",
        private: true,
        archived: false,
      },
    ]);
    expect(calls.at(-1)?.headers.get("authorization")).toBe(
      "Bearer ghs_lookupInstallationTokenSecret",
    );
  });

  it("follows the Link header across pages", async () => {
    const { client, calls } = makeClient({
      [`${REPOS}?page=1`]: "repos_page_1",
      [`${REPOS}?page=2`]: "repos_page_2",
    });
    const repos = await client.listInstallationRepositories("acme-eng");
    expect(repos.map((r) => r.name)).toEqual(["api", "web", "infra"]);
    expect(
      calls.filter((c) => c.path.startsWith("/installation/repositories")),
    ).toHaveLength(2);
  });

  it("returns an empty list", async () => {
    const { client } = makeClient({ [REPOS]: "repos_empty" });
    expect(await client.listInstallationRepositories("acme-eng")).toEqual([]);
  });

  for (const [suffix, kind] of ERRORS) {
    it(`maps ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [REPOS]: `repos_${suffix}` });
      const e = await errOf(client.listInstallationRepositories("acme-eng"));
      expect(e.kind).toBe(kind);
      expectNoSecrets(e);
    });
  }
});

describe("getCollaboratorPermission", () => {
  const roles: Array<[string, RepoRole]> = [
    ["permission_admin", "admin"],
    ["permission_maintain", "maintain"],
    ["permission_write", "write"],
    ["permission_triage", "triage"],
    ["permission_read", "read"],
    ["permission_none", "none"],
    ["permission_legacy_only", "write"],
  ];
  for (const [key, role] of roles) {
    it(`maps ${key} to ${role}`, async () => {
      const { client } = makeClient({ [PERM]: key });
      expect(
        await client.getCollaboratorPermission("acme-eng", "api", "octocat"),
      ).toBe(role);
    });
  }

  it("rejects an unknown role as an error, not none", async () => {
    const { client } = makeClient({ [PERM]: "permission_unknown_role" });
    const e = await errOf(
      client.getCollaboratorPermission("acme-eng", "api", "octocat"),
    );
    expect(e.kind).toBe("unexpected");
  });

  for (const [suffix, kind] of ERRORS) {
    it(`maps ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [PERM]: `permission_${suffix}` });
      const e = await errOf(
        client.getCollaboratorPermission("acme-eng", "api", "octocat"),
      );
      expect(e.kind).toBe(kind);
      expectNoSecrets(e);
    });
  }
});

describe("getUser", () => {
  it("returns the user", async () => {
    const { client } = makeClient({ [USER]: "user_success" });
    expect(await client.getUser("acme-eng", "octocat")).toEqual({
      id: 583231,
      login: "octocat",
      type: "User",
    });
  });

  it("reports a nonexistent user as not_found", async () => {
    const { client } = makeClient({ [USER]: "user_nonexistent" });
    const e = await errOf(client.getUser("acme-eng", "octocat"));
    expect(e.kind).toBe("not_found");
  });

  for (const [suffix, kind] of ERRORS) {
    it(`maps ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [USER]: `user_${suffix}` });
      const e = await errOf(client.getUser("acme-eng", "octocat"));
      expect(e.kind).toBe(kind);
      expectNoSecrets(e);
    });
  }
});

describe("isOrgMember", () => {
  it("is true on 204", async () => {
    const { client } = makeClient({ [MEMBER]: "member_yes" });
    expect(await client.isOrgMember("acme-eng", "octocat")).toBe(true);
  });

  it("is false on 404", async () => {
    const { client } = makeClient({ [MEMBER]: "member_no" });
    expect(await client.isOrgMember("acme-eng", "octocat")).toBe(false);
  });

  it("treats a 302 as an error, not as non-membership", async () => {
    const { client } = makeClient({ [MEMBER]: "member_redirect" });
    const e = await errOf(client.isOrgMember("acme-eng", "octocat"));
    expect(e.kind).toBe("unexpected");
  });

  for (const [suffix, kind] of ERRORS.filter(([s]) => s !== "404")) {
    it(`maps ${suffix} to ${kind}`, async () => {
      const { client } = makeClient({ [MEMBER]: `member_${suffix}` });
      const e = await errOf(client.isOrgMember("acme-eng", "octocat"));
      expect(e.kind).toBe(kind);
      expectNoSecrets(e);
    });
  }
});
