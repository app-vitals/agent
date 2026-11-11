/**
 * admin/src/github-enterprise-client.integration.test.ts
 * Integration tests for GithubEnterpriseClient against hand-authored cassettes
 * (fixtures/github-enterprise-cassette.json, derived from GitHub's ghec REST
 * OpenAPI description; nothing was recorded live).
 *
 * Replays through an INJECTED fetchFn: no global.fetch override, no
 * mock.module(). The RSA key is generated in-test.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  GithubEnterpriseClient,
  type GithubEnterpriseErrorKind,
} from "./github-enterprise-client.ts";

interface CassetteEntry {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL("./fixtures/github-enterprise-cassette.json", import.meta.url).pathname,
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
const ENT = "GET /enterprises/acme/installation";
const MINT = "POST /app/installations/4242/access_tokens";
const ORGS = "GET /enterprises/acme/apps/installable_organizations";
const INSTS = "GET /enterprises/acme/apps/organizations/acme-eng/installations";
const INSTALL = "POST /enterprises/acme/apps/organizations/acme-eng/installations";

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body?: string;
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
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const key = (page && routes[`${base}?page=${page}`]) || routes[base];
    if (!key) throw new Error(`no route for ${base} page=${page}`);
    const entry = cassette[key];
    if (!entry) throw new Error(`cassette key not found: ${key}`);
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json", ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const OK = { [ENT]: "enterprise_installation_success", [MINT]: "access_token_success" };

function makeClient(routes: Record<string, string>) {
  const { fetchFn, calls } = replay({ ...OK, ...routes });
  const client = new GithubEnterpriseClient({
    appId: "12345",
    enterprise: "acme",
    privateKey,
    apiBase: API,
    fetchFn,
    now: () => NOW,
  });
  return { client, calls };
}

const ERRORS: Array<[string, GithubEnterpriseErrorKind, number]> = [
  ["403", "permission", 403],
  ["403_secondary_rate_limit", "rate_limit", 403],
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
    return e as Error & { kind: GithubEnterpriseErrorKind; status?: number };
  }
  throw new Error("expected rejection");
}

function expectNoSecrets(e: Error) {
  expect(e.message).not.toContain("PRIVATE KEY");
  expect(e.message).not.toContain("ghs_cassette");
  expect(e.message).not.toContain("Bearer");
}

describe("getInstallationToken", () => {
  it("tags a 404 on the enterprise installation lookup with its step (GHE-1.10)", async () => {
    const { client } = makeClient({ [ENT]: "enterprise_installation_404" });
    const e = await errOf(client.getInstallationToken());
    expect(e.kind).toBe("not_found");
    expect((e as { step?: string }).step).toBe("installation_lookup");
  });

  it("does not tag a 404 on the access-token mint as an installation lookup", async () => {
    const { client } = makeClient({ [MINT]: "access_token_404" });
    const e = await errOf(client.getInstallationToken());
    expect(e.kind).toBe("not_found");
    expect((e as { step?: string }).step).toBeUndefined();
  });

  it("looks up the enterprise installation with a JWT then mints a token", async () => {
    const { client, calls } = makeClient({});
    const t = await client.getInstallationToken();
    expect(t).toEqual({
      token: "ghs_cassetteInstallationToken0000000000",
      expiresAt: "2026-11-09T13:00:00Z",
      installationId: 4242,
      permissions: { enterprise_organization_installations: "write", metadata: "read" },
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([ENT, MINT]);
    for (const c of calls) {
      expect(c.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(c.headers.get("accept")).toBe("application/vnd.github+json");
    }
  });

  it("caches the token until near expiry", async () => {
    const { client, calls } = makeClient({});
    await client.getInstallationToken();
    await client.getInstallationToken();
    expect(calls).toHaveLength(2);
  });

  for (const [suffix, kind, status] of ERRORS) {
    it(`lookup ${suffix} -> ${kind}`, async () => {
      const { client } = makeClient({ [ENT]: `enterprise_installation_${suffix}` });
      const e = await errOf(client.getInstallationToken());
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
    it(`mint ${suffix} -> ${kind}`, async () => {
      const { client } = makeClient({ [MINT]: `access_token_${suffix}` });
      const e = await errOf(client.getInstallationToken());
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
  }

  it("maps a thrown fetch to a network error without echoing the cause", async () => {
    const client = new GithubEnterpriseClient({
      appId: "1",
      enterprise: "acme",
      privateKey,
      apiBase: API,
      fetchFn: (async () => {
        throw new Error("connect ECONNREFUSED Bearer abc");
      }) as unknown as typeof fetch,
    });
    const e = await errOf(client.getInstallationToken());
    expect(e.kind).toBe("network");
    expect(e.message).not.toContain("abc");
  });
});

describe("listInstallableOrganizations", () => {
  it("returns orgs using the installation token", async () => {
    const { client, calls } = makeClient({ [ORGS]: "installable_orgs_success" });
    expect(await client.listInstallableOrganizations()).toEqual([
      { id: 1, login: "org-1" },
      { id: 2, login: "org-2" },
    ]);
    const last = calls[calls.length - 1] as Recorded;
    expect(last.path).toBe(
      "/enterprises/acme/apps/installable_organizations?per_page=100&page=1",
    );
    expect(last.headers.get("authorization")).toBe(
      "Bearer ghs_cassetteInstallationToken0000000000",
    );
  });

  it("follows Link rel=next across pages", async () => {
    const { client, calls } = makeClient({
      [`${ORGS}?page=1`]: "installable_orgs_page_1",
      [`${ORGS}?page=2`]: "installable_orgs_page_2",
    });
    const orgs = await client.listInstallableOrganizations();
    expect(orgs.map((o) => o.login)).toEqual(["org-1", "org-2", "org-3"]);
    expect(calls.filter((c) => c.path.includes("installable_organizations"))).toHaveLength(2);
  });

  it("returns an empty list", async () => {
    const { client } = makeClient({ [ORGS]: "installable_orgs_empty" });
    expect(await client.listInstallableOrganizations()).toEqual([]);
  });

  for (const [suffix, kind, status] of ERRORS) {
    it(`${suffix} -> ${kind}`, async () => {
      const { client } = makeClient({ [ORGS]: `installable_orgs_${suffix}` });
      const e = await errOf(client.listInstallableOrganizations());
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
  }
});

describe("listOrgInstallations", () => {
  it("maps installations", async () => {
    const { client } = makeClient({ [INSTS]: "org_installations_success" });
    const list = await client.listOrgInstallations("acme-eng");
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: 501,
      appId: 777,
      appSlug: "target-app",
      clientId: "Iv1.targetapp0001",
      accountLogin: "acme-eng",
      repositorySelection: "all",
    });
  });

  it("paginates", async () => {
    const { client } = makeClient({
      [`${INSTS}?page=1`]: "org_installations_page_1",
      [`${INSTS}?page=2`]: "org_installations_page_2",
    });
    const list = await client.listOrgInstallations("acme-eng");
    expect(list.map((i) => i.id)).toEqual([501, 502]);
  });

  for (const [suffix, kind, status] of ERRORS) {
    it(`${suffix} -> ${kind}`, async () => {
      const { client } = makeClient({ [INSTS]: `org_installations_${suffix}` });
      const e = await errOf(client.listOrgInstallations("acme-eng"));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
  }
});

describe("installOnOrg", () => {
  it("posts client_id and repository_selection; 201 means created", async () => {
    const { client, calls } = makeClient({ [INSTALL]: "install_created" });
    const r = await client.installOnOrg("acme-eng", {
      clientId: "Iv1.targetapp0001",
      repositorySelection: "all",
    });
    expect(r.created).toBe(true);
    expect(r.installation.id).toBe(601);
    const last = calls[calls.length - 1] as Recorded;
    expect(last.method).toBe("POST");
    expect(JSON.parse(last.body ?? "")).toEqual({
      client_id: "Iv1.targetapp0001",
      repository_selection: "all",
    });
  });

  it("200 means already installed", async () => {
    const { client } = makeClient({ [INSTALL]: "install_already_installed" });
    const r = await client.installOnOrg("acme-eng", {
      clientId: "Iv1.targetapp0001",
      repositorySelection: "all",
    });
    expect(r.created).toBe(false);
  });

  it("sends repositories for selected", async () => {
    const { client, calls } = makeClient({ [INSTALL]: "install_selected_created" });
    const r = await client.installOnOrg("acme-eng", {
      clientId: "Iv1.targetapp0001",
      repositorySelection: "selected",
      repositories: ["hello-world"],
    });
    expect(r.installation.repositorySelection).toBe("selected");
    expect(JSON.parse((calls[calls.length - 1] as Recorded).body ?? "")).toEqual({
      client_id: "Iv1.targetapp0001",
      repository_selection: "selected",
      repositories: ["hello-world"],
    });
  });

  it("sends none without repositories", async () => {
    const { client, calls } = makeClient({ [INSTALL]: "install_created" });
    await client.installOnOrg("acme-eng", {
      clientId: "Iv1.x",
      repositorySelection: "none",
      repositories: ["ignored"],
    });
    expect(JSON.parse((calls[calls.length - 1] as Recorded).body ?? "")).toEqual({
      client_id: "Iv1.x",
      repository_selection: "none",
    });
  });

  for (const [suffix, kind, status] of ERRORS) {
    it(`${suffix} -> ${kind}`, async () => {
      const { client } = makeClient({ [INSTALL]: `install_${suffix}` });
      const e = await errOf(
        client.installOnOrg("acme-eng", { clientId: "Iv1.x", repositorySelection: "all" }),
      );
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expectNoSecrets(e);
    });
  }
});
