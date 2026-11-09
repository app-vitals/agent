/**
 * admin/src/github-enterprise-client.unit.test.ts
 * Unit tests for GitHub enterprise error mapping and client-side validation.
 */

import { describe, expect, it } from "bun:test";
import {
  GithubEnterpriseClient,
  GithubEnterpriseError,
  type GithubEnterpriseErrorKind,
  mapGithubEnterpriseError,
} from "./github-enterprise-client.ts";

const h = (init?: Record<string, string>) => new Headers(init);

describe("mapGithubEnterpriseError", () => {
  const cases: Array<
    [number, Record<string, string>, unknown, GithubEnterpriseErrorKind]
  > = [
    [401, {}, { message: "Bad credentials" }, "unauthorized"],
    [
      403,
      {},
      { message: "Resource not accessible by integration" },
      "permission",
    ],
    [404, {}, { message: "Not Found" }, "not_found"],
    [422, {}, { message: "Validation Failed" }, "validation"],
    [429, {}, { message: "API rate limit exceeded" }, "rate_limit"],
    [403, { "retry-after": "60" }, { message: "x" }, "rate_limit"],
    [403, { "x-ratelimit-remaining": "0" }, { message: "x" }, "rate_limit"],
    [
      403,
      {},
      { message: "You have exceeded a secondary rate limit." },
      "rate_limit",
    ],
    [500, {}, { message: "Server Error" }, "server"],
    [503, {}, undefined, "server"],
    [418, {}, undefined, "unexpected"],
  ];
  for (const [status, headers, body, kind] of cases) {
    it(`maps ${status} ${JSON.stringify(headers)} to ${kind}`, () => {
      const e = mapGithubEnterpriseError(status, h(headers), body, "ctx");
      expect(e).toBeInstanceOf(GithubEnterpriseError);
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
    });
  }

  it("exposes retry-after seconds", () => {
    const e = mapGithubEnterpriseError(
      429,
      h({ "retry-after": "30" }),
      {},
      "ctx",
    );
    expect(e.retryAfterSeconds).toBe(30);
  });

  it("redacts secrets echoed in the message", () => {
    const e = mapGithubEnterpriseError(
      403,
      h(),
      { message: "token ghs_secret123 denied" },
      "ctx",
      ["ghs_secret123"],
    );
    expect(e.message).not.toContain("ghs_secret123");
  });
});

describe("GithubEnterpriseClient validation", () => {
  const neverFetch = (async () => {
    throw new Error("fetch must not be called");
  }) as unknown as typeof fetch;
  const client = new GithubEnterpriseClient({
    appId: "1",
    enterprise: "acme",
    privateKey: "unused",
    fetchFn: neverFetch,
  });

  it("rejects selected without repositories before any network call", async () => {
    const err = await client
      .installOnOrg("o", { clientId: "Iv1.x", repositorySelection: "selected" })
      .catch((e) => e);
    expect(err.kind).toBe("validation");
  });

  it("rejects a missing clientId", async () => {
    const err = await client
      .installOnOrg("o", { clientId: "", repositorySelection: "all" })
      .catch((e) => e);
    expect(err.kind).toBe("validation");
  });
});
