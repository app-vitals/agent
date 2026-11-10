/**
 * admin/src/user-repo-access-resolver.integration.test.ts
 * UserRepoAccessResolver driven through the real GithubLookupClient replaying
 * the GHE-2.2 cassettes (injected fetchFn; no global overrides).
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { GithubLookupClient } from "./github-lookup-client.ts";
import { UserRepoAccessResolver } from "./user-repo-access-resolver.ts";

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
const BASE: Record<string, string> = {
  "GET /orgs/acme-eng/installation": "org_installation_success",
  "POST /app/installations/7001/access_tokens": "lookup_token_success",
  "GET /installation/repositories": "repos_success",
  "GET /users/octocat": "user_success",
};

function setup(routes: Record<string, string>) {
  const all = { ...BASE, ...routes };
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    const name = all[key];
    if (!name) throw new Error(`no route for ${key}`);
    const e = cassette[name];
    if (!e) throw new Error(`cassette key not found: ${name}`);
    return new Response(
      e.status === 204 || e.status === 302 ? null : JSON.stringify(e.body),
      {
        status: e.status,
        headers: { "Content-Type": "application/json", ...(e.headers ?? {}) },
      },
    );
  }) as typeof fetch;
  const lookup = new GithubLookupClient({
    appId: "555",
    privateKey,
    apiBase: "https://ghe.test",
    fetchFn,
    now: () => NOW,
  });
  const resolver = new UserRepoAccessResolver({
    installer: {
      listInstallableOrganizations: async () => [{ id: 11, login: "acme-eng" }],
    },
    lookup,
    now: () => NOW,
    concurrency: 1,
  });
  return { resolver, calls };
}

const API = "GET /repos/acme-eng/api/collaborators/octocat/permission";
const WEB = "GET /repos/acme-eng/web/collaborators/octocat/permission";

describe("UserRepoAccessResolver against GHE-2.2 cassettes", () => {
  it("complete run", async () => {
    const { resolver } = setup({
      [API]: "permission_maintain",
      [WEB]: "permission_triage",
    });
    const res = await resolver.resolve("octocat");
    expect(res.complete).toBe(true);
    expect(res.outcome).toBe("ok");
    expect(res.unresolved).toBe(0);
    expect(res.orgs).toEqual([
      {
        org: "acme-eng",
        status: "ok",
        repos: [
          { fullName: "acme-eng/api", level: "maintain", canPush: true },
          { fullName: "acme-eng/web", level: "triage", canPush: false },
        ],
        unresolved: 0,
      },
    ]);
  });

  it("partial run: 429 mid-org keeps resolved and stops further calls", async () => {
    const { resolver, calls } = setup({
      [API]: "permission_write",
      [WEB]: "permission_429",
    });
    const res = await resolver.resolve("octocat");
    expect(res.complete).toBe(false);
    expect(res.orgs[0].status).toBe("partial");
    expect(res.orgs[0].repos).toEqual([
      { fullName: "acme-eng/api", level: "write", canPush: true },
    ]);
    expect(res.orgs[0].unresolved).toBe(1);
    expect(res.unresolved).toBe(1);
    expect(calls.filter((c) => c.includes("/permission"))).toEqual([API, WEB]);
  });

  it("rate-limited run: 429 before anything resolved", async () => {
    const { resolver } = setup({
      [API]: "permission_429",
      [WEB]: "permission_read",
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].status).toBe("rate_limited");
    expect(res.orgs[0].repos).toEqual([]);
    expect(res.orgs[0].unresolved).toBe(2);
    expect(res.complete).toBe(false);
  });

  it("missing-user run", async () => {
    const { resolver, calls } = setup({
      "GET /users/octocat": "user_nonexistent",
    });
    const res = await resolver.resolve("octocat");
    expect(res.outcome).toBe("user_not_found");
    expect(res.orgs).toEqual([]);
    expect(calls.some((c) => c.includes("/permission"))).toBe(false);
  });

  it("org without the lookup app", async () => {
    const { resolver } = setup({
      "GET /orgs/acme-eng/installation": "org_installation_404",
    });
    const res = await resolver.resolve("octocat");
    expect(res.orgs[0].status).toBe("lookup_app_not_installed");
    expect(res.complete).toBe(false);
  });

  it("never leaks the installation token", async () => {
    const { resolver } = setup({
      [API]: "permission_503",
      [WEB]: "permission_503",
    });
    const res = await resolver.resolve("octocat");
    expect(JSON.stringify(res)).not.toContain("ghs_lookup");
  });
});
