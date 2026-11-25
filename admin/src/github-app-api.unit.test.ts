/**
 * admin/src/github-app-api.unit.test.ts
 * Unit tests for fetchPublicApp / fetchAuthenticatedApp. fetch is injected via
 * `fetchFn`; the RSA key is generated in-test. No network, no fixtures.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { fetchAuthenticatedApp, fetchPublicApp } from "./github-app-api.ts";
import { GithubEnterpriseError } from "./github-enterprise-client.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = new Date("2026-11-09T12:00:00Z");

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(respond: () => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function caught(p: Promise<unknown>): Promise<GithubEnterpriseError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GithubEnterpriseError);
    return e as GithubEnterpriseError;
  }
  throw new Error("expected rejection");
}

describe("fetchPublicApp", () => {
  it("returns slug and clientId and sends no credentials", async () => {
    const { fetchFn, calls } = stubFetch(() =>
      json({ slug: "my-app", client_id: "Iv1.abc" }),
    );
    const app = await fetchPublicApp("my-app", { fetchFn });
    expect(app).toEqual({ slug: "my-app", clientId: "Iv1.abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/apps/my-app");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("honours apiBase and url-encodes the slug", async () => {
    const { fetchFn, calls } = stubFetch(() => json({}));
    await fetchPublicApp("a/b", {
      fetchFn,
      apiBase: "https://ghe.example/api/v3",
    });
    expect(calls[0].url).toBe("https://ghe.example/api/v3/apps/a%2Fb");
  });

  it("falls back to the requested slug and null clientId when fields are missing", async () => {
    const { fetchFn } = stubFetch(() => json({ client_id: "" }));
    expect(await fetchPublicApp("x", { fetchFn })).toEqual({
      slug: "x",
      clientId: null,
    });
  });

  it("tolerates a non-JSON success body", async () => {
    const { fetchFn } = stubFetch(() => new Response("ok", { status: 200 }));
    expect(await fetchPublicApp("x", { fetchFn })).toEqual({
      slug: "x",
      clientId: null,
    });
  });

  it("maps 404 (private App) to a not_found GithubEnterpriseError", async () => {
    const { fetchFn } = stubFetch(() => json({ message: "Not Found" }, 404));
    const err = await caught(fetchPublicApp("private-app", { fetchFn }));
    expect(err.kind).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.message).toContain("GitHub public App lookup");
  });

  it("maps 500 to server and rate-limited 403 to rate_limit with retryAfterSeconds", async () => {
    const s = stubFetch(() => json({ message: "boom" }, 500));
    expect(
      (await caught(fetchPublicApp("x", { fetchFn: s.fetchFn }))).kind,
    ).toBe("server");

    const r = stubFetch(() =>
      json({ message: "API rate limit exceeded" }, 403, {
        "retry-after": "30",
      }),
    );
    const err = await caught(fetchPublicApp("x", { fetchFn: r.fetchFn }));
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("maps a thrown fetch to a network error without leaking the cause", async () => {
    const { fetchFn } = stubFetch(() => {
      throw new Error("ECONNRESET secret-detail");
    });
    const err = await caught(fetchPublicApp("x", { fetchFn }));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain("secret-detail");
  });

  it("maps an error with a non-JSON body to a typed error", async () => {
    const { fetchFn } = stubFetch(
      () => new Response("<html>", { status: 502 }),
    );
    expect((await caught(fetchPublicApp("x", { fetchFn }))).kind).toBe(
      "server",
    );
  });
});

describe("fetchAuthenticatedApp", () => {
  const base = { appId: "12345", privateKey, now: () => NOW };

  it("returns permissions and sends a Bearer app JWT to /app", async () => {
    const { fetchFn, calls } = stubFetch(() =>
      json({ permissions: { metadata: "read", members: "read" } }),
    );
    const out = await fetchAuthenticatedApp({ ...base, fetchFn });
    expect(out).toEqual({ permissions: { metadata: "read", members: "read" } });
    expect(calls[0].url).toBe("https://api.github.com/app");
    const auth = (calls[0].init.headers as Record<string, string>)
      .Authorization;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(
      Buffer.from(auth.slice(7).split(".")[1], "base64url").toString(),
    );
    expect(payload.iss).toBe("12345");
  });

  it("returns empty permissions when the field is absent or not an object", async () => {
    for (const body of [{}, { permissions: "nope" }, { permissions: null }]) {
      const { fetchFn } = stubFetch(() => json(body));
      expect(await fetchAuthenticatedApp({ ...base, fetchFn })).toEqual({
        permissions: {},
      });
    }
  });

  it("maps 401 to unauthorized and 404 to not_found", async () => {
    const u = stubFetch(() => json({ message: "Bad credentials" }, 401));
    const e401 = await caught(
      fetchAuthenticatedApp({ ...base, fetchFn: u.fetchFn }),
    );
    expect(e401.kind).toBe("unauthorized");
    expect(e401.message).toContain("GitHub App lookup");

    const n = stubFetch(() => json({ message: "Not Found" }, 404));
    expect(
      (await caught(fetchAuthenticatedApp({ ...base, fetchFn: n.fetchFn })))
        .kind,
    ).toBe("not_found");
  });

  it("maps a thrown fetch to a network error", async () => {
    const { fetchFn } = stubFetch(() => {
      throw new Error("down");
    });
    expect(
      (await caught(fetchAuthenticatedApp({ ...base, fetchFn }))).kind,
    ).toBe("network");
  });

  it("redacts the JWT and private key if the server echoes them in an error", async () => {
    let jwt = "";
    const stub = stubFetch(() =>
      json({ message: `bad token ${jwt} key ${privateKey}` }, 401),
    );
    const capture = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const { Authorization } = (init?.headers ?? {}) as Record<string, string>;
      jwt = Authorization.slice(7);
      return stub.fetchFn(url, init);
    }) as typeof fetch;
    const err = await caught(
      fetchAuthenticatedApp({ ...base, fetchFn: capture }),
    );
    expect(jwt.length).toBeGreaterThan(0);
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(jwt);
    expect(err.message).not.toContain("PRIVATE KEY");
  });

  it("never puts the key in a result or an error for an unusable key", async () => {
    const { fetchFn, calls } = stubFetch(() => json({}));
    const bad =
      "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----";
    let message = "";
    try {
      await fetchAuthenticatedApp({ appId: "1", privateKey: bad, fetchFn });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("invalid or unusable RSA private key");
    expect(message).not.toContain("not-a-real-key");
    expect(calls).toHaveLength(0);
  });

  it("the successful result does not contain the key", async () => {
    const { fetchFn } = stubFetch(() =>
      json({ permissions: { metadata: "read" } }),
    );
    const out = await fetchAuthenticatedApp({ ...base, fetchFn });
    expect(JSON.stringify(out)).not.toContain("PRIVATE KEY");
  });
});
