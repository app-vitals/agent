/**
 * admin/src/github-enterprise-client-page.unit.test.ts
 * GithubEnterpriseClient.listInstallationRepositoriesPage: one page, Link-header
 * driven hasNext, archived passthrough, validation.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubEnterpriseClient } from "./github-enterprise-client.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function make(repoResp: () => Response) {
  const paths: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const u = new URL(input.toString());
    paths.push(`${u.pathname}${u.search}`);
    if (u.pathname.endsWith("/installation"))
      return Response.json({ id: 1 });
    if (u.pathname.endsWith("/access_tokens"))
      return Response.json(
        { token: "t", expires_at: "2099-01-01T00:00:00Z" },
        { status: 201 },
      );
    return repoResp();
  }) as typeof fetch;
  return {
    paths,
    client: new GithubEnterpriseClient({
      appId: "1",
      enterprise: "ent",
      privateKey,
      apiBase: "https://ghe.test",
      fetchFn,
    }),
  };
}

describe("listInstallationRepositoriesPage", () => {
  it("fetches only the requested page and reads the Link header", async () => {
    const { client, paths } = make(() =>
      Response.json([{ id: 1, name: "a", full_name: "o/a", archived: true }], {
        headers: { link: '<https://x?page=3>; rel="next"' },
      }),
    );
    const res = await client.listInstallationRepositoriesPage("o", 5, 2);
    expect(res).toEqual({
      repos: [{ id: 1, name: "a", fullName: "o/a", archived: true }],
      hasNext: true,
      perPage: 100,
    });
    expect(paths.filter((p) => p.includes("/repositories"))).toEqual([
      "/enterprises/ent/apps/organizations/o/installations/5/repositories?per_page=100&page=2",
    ]);
  });

  it("without a Link header, hasNext is whether the page is full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: "n",
      full_name: "o/n",
    }));
    expect(
      (await make(() => Response.json(full)).client.listInstallationRepositoriesPage("o", 5, 1)).hasNext,
    ).toBe(true);
    expect(
      (await make(() => Response.json(full.slice(0, 3))).client.listInstallationRepositoriesPage("o", 5, 1)).hasNext,
    ).toBe(false);
  });

  it("maps a 429 to a rate_limit error with retry-after", async () => {
    const { client } = make(
      () =>
        new Response(JSON.stringify({ message: "limit" }), {
          status: 429,
          headers: { "retry-after": "12" },
        }),
    );
    const err = await client
      .listInstallationRepositoriesPage("o", 5, 1)
      .catch((e) => e);
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("rejects a bad page or installation id before any request", async () => {
    const { client, paths } = make(() => Response.json([]));
    expect(
      (await client.listInstallationRepositoriesPage("o", 5, 0).catch((e) => e)).kind,
    ).toBe("validation");
    expect(
      (await client.listInstallationRepositoriesPage("o", Number.NaN, 1).catch((e) => e)).kind,
    ).toBe("validation");
    expect(paths).toEqual([]);
  });
});
