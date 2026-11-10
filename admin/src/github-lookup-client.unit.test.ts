/**
 * admin/src/github-lookup-client.unit.test.ts
 * Unit tests for role mapping and error handling of GithubLookupClient.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import {
  GithubLookupClient,
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
