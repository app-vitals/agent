/**
 * admin/src/github-lookup-repositories.integration.test.ts
 * The AdminPlatformServices.githubLookup lister over a real GithubLookupClient
 * replaying hand-authored responses through an injected fetchFn (no global
 * fetch override). The installer side is a stub org list. RSA key generated
 * in-test.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";
import { GithubLookupClient } from "./github-lookup-client.ts";
import { createGithubLookupService } from "./github-lookup-repositories.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = new Date("2026-11-09T12:00:00Z");
const INSTALLATIONS: Record<string, number> = { acme: 1, beta: 2 };

const repo = (owner: string, name: string, archived = false, id = 1) => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  private: true,
  archived,
});

type Handler = (url: URL, installId?: number) => Response;

/** Replays the org-installation, token and repository-list endpoints. */
function replay(repos: Handler) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    const method = init?.method ?? "GET";
    const inst = u.pathname.match(/^\/orgs\/([^/]+)\/installation$/);
    if (inst) {
      const id = INSTALLATIONS[inst[1]];
      return id
        ? Response.json({ id, repository_selection: "all" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const mint = u.pathname.match(
      /^\/app\/installations\/(\d+)\/access_tokens$/,
    );
    if (mint && method === "POST") {
      return Response.json({
        token: `ghs_tok${mint[1]}`,
        expires_at: "2026-11-09T13:00:00Z",
      });
    }
    if (u.pathname === "/installation/repositories") {
      const bearer = String(new Headers(init?.headers).get("authorization"));
      return repos(u, Number(bearer.replace(/\D/g, "")));
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function service(orgs: string[], fetchFn: typeof fetch) {
  return createGithubLookupService({
    appService: {} as never,
    clients: {
      installer: {
        listInstallableOrganizations: async () =>
          orgs.map((login) => ({ login })),
      },
      lookup: new GithubLookupClient({
        appId: "555",
        privateKey,
        fetchFn,
        now: () => NOW,
      }),
    },
  });
}

describe("githubLookup.listRepositories", () => {
  it("lists repos across multiple orgs, carrying archived", async () => {
    const svc = service(
      ["acme", "beta"],
      replay((_u, id) =>
        Response.json({
          repositories:
            id === 1
              ? [repo("acme", "api", false, 10), repo("acme", "old", true, 11)]
              : [repo("beta", "web", false, 20)],
        }),
      ),
    );
    expect(await svc.listRepositories()).toEqual({
      configured: true,
      repos: [
        { fullName: "acme/api", archived: false },
        { fullName: "acme/old", archived: true },
        { fullName: "beta/web", archived: false },
      ],
    });
  });

  it("follows pagination within an org", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      repo("acme", `r${i}`, false, i),
    );
    const svc = service(
      ["acme"],
      replay((u) =>
        u.searchParams.get("page") === "1"
          ? Response.json(
              { repositories: page1 },
              { headers: { link: '<https://x/?page=2>; rel="next"' } },
            )
          : Response.json({ repositories: [repo("acme", "last", false, 999)] }),
      ),
    );
    const out = await svc.listRepositories();
    expect(out.repos).toHaveLength(101);
    expect(out.repos.at(-1)).toEqual({
      fullName: "acme/last",
      archived: false,
    });
  });

  it("skips an org without the lookup App installed", async () => {
    const svc = service(
      ["ghost", "acme"],
      replay(() => Response.json({ repositories: [repo("acme", "api")] })),
    );
    expect((await svc.listRepositories()).repos).toEqual([
      { fullName: "acme/api", archived: false },
    ]);
  });

  it("returns configured:false with no repos when the Apps are not set", async () => {
    const svc = createGithubLookupService({
      appService: {
        get: async () => null,
        getPrivateKey: async () => null,
      },
    });
    expect(await svc.listRepositories()).toEqual({
      configured: false,
      repos: [],
    });
  });

  it("rejects on a GitHub error instead of returning an empty list", async () => {
    const svc = service(
      ["acme"],
      replay(() => Response.json({ message: "boom" }, { status: 500 })),
    );
    const err = await svc.listRepositories().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GithubEnterpriseError);
    expect((err as GithubEnterpriseError).kind).toBe("server");
  });

  it("rejects when listing installable organizations fails", async () => {
    const svc = createGithubLookupService({
      appService: {} as never,
      clients: {
        installer: {
          listInstallableOrganizations: async () => {
            throw new GithubEnterpriseError("rate_limit", "limited");
          },
        },
        lookup: { listInstallationRepositories: async () => [] },
      },
    });
    await expect(svc.listRepositories()).rejects.toThrow("limited");
  });
});
