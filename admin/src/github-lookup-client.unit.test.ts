/**
 * admin/src/github-lookup-client.unit.test.ts
 * Unit tests for role mapping and error handling of GithubLookupClient.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  GithubLookupClient,
  GithubLookupRateLimitError,
  mapRepoRole,
  REPO_ROLES,
} from "./github-lookup-client.ts";

describe("mapRepoRole", () => {
  it.each([...REPO_ROLES])("maps %s to itself", (role) => {
    expect(mapRepoRole(role)).toBe(role);
  });

  it.each(["custom-role", "ADMIN", "", "owner"])(
    "rejects unknown role %p instead of treating it as none",
    (role) => {
      try {
        mapRepoRole(role);
      } catch (e) {
        expect(e).toBeInstanceOf(GithubEnterpriseError);
        expect((e as GithubEnterpriseError).kind).toBe("unexpected");
        return;
      }
      throw new Error("expected rejection");
    },
  );

  it.each([undefined, null, 5, {}])("rejects non-string role %p", (role) => {
    expect(() => mapRepoRole(role)).toThrow(GithubEnterpriseError);
  });
});

describe("GithubLookupClient errors", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  it("reports a network failure as kind network without the underlying message", async () => {
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async () => {
        throw new Error("connect failed Authorization: Bearer ghs_leak");
      }) as unknown as typeof fetch,
    });
    try {
      await client.getOrgToken("acme-eng");
    } catch (e) {
      const err = e as GithubEnterpriseError;
      expect(err.kind).toBe("network");
      expect(err.message).not.toContain("ghs_leak");
      return;
    }
    throw new Error("expected rejection");
  });

  it("redacts an echoed token from an error message", async () => {
    let n = 0;
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (n === 1) return Response.json({ id: 1 });
        const bearer = String(
          new Headers(init?.headers).get("authorization"),
        ).slice(7);
        return Response.json(
          { message: `bad credentials ${bearer}` },
          { status: 401 },
        );
      }) as unknown as typeof fetch,
    });
    try {
      await client.getOrgToken("acme-eng");
    } catch (e) {
      const err = e as GithubEnterpriseError;
      expect(err.kind).toBe("unauthorized");
      expect(err.message).toContain("[redacted]");
      expect(err.message).not.toMatch(/eyJ/);
      return;
    }
    throw new Error("expected rejection");
  });
});

describe("GithubLookupClient.listInstallations", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const inst = (id: number, login: string, type = "Organization") => ({
    id,
    account: { login, type },
  });

  it("paginates with the App JWT and keeps only organization installs", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => inst(i, `org${i}`));
    const seen: string[] = [];
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(input.toString());
        expect(u.pathname).toBe("/app/installations");
        expect(
          String(new Headers(init?.headers).get("authorization")),
        ).toStartWith("Bearer ey");
        seen.push(u.searchParams.get("page") ?? "");
        return u.searchParams.get("page") === "1"
          ? Response.json(page1, {
              headers: { link: '<https://x/?page=2>; rel="next"' },
            })
          : Response.json([inst(900, "last"), inst(901, "someone", "User")]);
      }) as unknown as typeof fetch,
    });
    const out = await client.listInstallations();
    expect(seen).toEqual(["1", "2"]);
    expect(out).toHaveLength(101);
    expect(out.at(-1)).toEqual({ id: 900, login: "last" });
  });

  it("rejects on a GitHub error", async () => {
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async () =>
        Response.json(
          { message: "boom" },
          { status: 500 },
        )) as unknown as typeof fetch,
    });
    await expect(client.listInstallations()).rejects.toBeInstanceOf(
      GithubEnterpriseError,
    );
  });

  it("rejects a non-list response", async () => {
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async () => Response.json({})) as unknown as typeof fetch,
    });
    await expect(client.listInstallations()).rejects.toThrow(
      "not an installation list",
    );
  });
});

describe("GithubLookupClient request timeout", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  /** A fetch that never answers on its own; it only rejects when aborted. */
  const hanging = (signals: AbortSignal[]) =>
    ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would hang forever: the test times out
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason));
      })) as unknown as typeof fetch;

  it("aborts a hung request after requestTimeoutMs as a network error", async () => {
    const signals: AbortSignal[] = [];
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: hanging(signals),
      requestTimeoutMs: 20,
    });
    try {
      await client.getOrgToken("acme-eng");
    } catch (e) {
      const err = e as GithubEnterpriseError;
      expect(err).toBeInstanceOf(GithubEnterpriseError);
      expect(err.kind).toBe("network");
      expect(err.message).toContain("timed out");
      expect(signals).toHaveLength(1);
      return;
    }
    throw new Error("expected rejection");
  });

  it("passes an abort signal on every request, including page fetches", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client = new GithubLookupClient({
      appId: "555",
      privateKey,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        const path = new URL(input.toString()).pathname;
        if (path === "/orgs/acme-eng/installation")
          return Response.json({ id: 1 });
        if (path === "/app/installations/1/access_tokens")
          return Response.json({
            token: "ghs_x",
            expires_at: "2999-01-01T00:00:00Z",
          });
        return Response.json({ total_count: 0, repositories: [] });
      }) as unknown as typeof fetch,
    });
    await client.listInstallationRepositoriesPage("acme-eng", 1);
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });
});

describe("GithubLookupClient.listInstallationRepositoriesPage", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const NOW = new Date("2026-11-20T12:00:00Z");

  function clientFor(reposResponse: () => Response) {
    return new GithubLookupClient({
      appId: "555",
      privateKey,
      now: () => NOW,
      fetchFn: (async (input: RequestInfo | URL) => {
        const path = new URL(input.toString()).pathname;
        if (path === "/orgs/acme-eng/installation")
          return Response.json({ id: 1 });
        if (path === "/app/installations/1/access_tokens")
          return Response.json({
            token: "ghs_x",
            expires_at: "2999-01-01T00:00:00Z",
          });
        return reposResponse();
      }) as unknown as typeof fetch,
    });
  }

  it("rejects a response without a numeric total_count", async () => {
    const client = clientFor(() => Response.json({ repositories: [] }));
    await expect(
      client.listInstallationRepositoriesPage("acme-eng", 1),
    ).rejects.toThrow("total_count");
  });

  it("rejects a page number below 1", async () => {
    const client = clientFor(() =>
      Response.json({ total_count: 0, repositories: [] }),
    );
    await expect(
      client.listInstallationRepositoriesPage("acme-eng", 0),
    ).rejects.toThrow("page");
  });

  it("falls back to a short page when there is no Link header", async () => {
    const client = clientFor(() =>
      Response.json({
        total_count: 1,
        repositories: [{ id: 1, name: "a", full_name: "acme-eng/a" }],
      }),
    );
    const page = await client.listInstallationRepositoriesPage("acme-eng", 1);
    expect(page.hasNext).toBe(false);
    expect(page.rateLimit).toEqual({
      remaining: null,
      resetAt: null,
      retryAfterSeconds: null,
    });
  });

  it("defaults a rate limit without reset hints to one minute out", async () => {
    const client = clientFor(() =>
      Response.json({ message: "API rate limit exceeded" }, { status: 429 }),
    );
    try {
      await client.listInstallationRepositoriesPage("acme-eng", 1);
    } catch (e) {
      expect(e).toBeInstanceOf(GithubLookupRateLimitError);
      expect((e as GithubLookupRateLimitError).kind).toBe("rate_limit");
      expect((e as GithubLookupRateLimitError).resetAt).toEqual(
        new Date(NOW.getTime() + 60_000),
      );
      return;
    }
    throw new Error("expected rejection");
  });
});
