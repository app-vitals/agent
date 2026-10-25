/**
 * admin/src/admin-spec.smoke.test.ts
 *
 * Smoke tests for the platform OpenAPI document served at GET /doc.
 * The route is flag-gated: SHIPWRIGHT_ADMIN_DOC_ENABLED="enabled" mounts it
 * (see platform-doc-route.ts, wired in admin-boot.ts) behind the admin auth
 * middleware; with the flag off the route is not mounted at all (404).
 * Uses app.request() — no real server, no real DB.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { buildPlatformAdminSpec } from "./admin-spec.ts";
import { createAdminAuthMiddleware, parseAdminApiKeys } from "./api-auth.ts";
import { mountPlatformDoc } from "./platform-doc-route.ts";

function buildApp(env: Record<string, string | undefined>) {
  const root = new Hono();
  root.get("/health", (c) => c.json({ status: "ok" }));
  mountPlatformDoc(root, {
    env,
    auth: createAdminAuthMiddleware({
      sessionSecret: "test-secret-32chars-for-doc-route!",
      agentTokenService: { validate: async () => null },
      adminApiKeys: parseAdminApiKeys(
        "root:tok-admin:*,ro:tok-read:platform.read,ops:tok-ops:platform.ops,bot:tok-agent:agent-1",
      ),
    }),
  });
  return root;
}

// The auth middleware and the handler both register under /doc; dedupe.
const routes = (app: Hono) => [
  ...new Set(app.routes.map((r) => `${r.method} ${r.path}`)),
];
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe("GET /doc", () => {
  it("flag off: route is not mounted and returns 404", async () => {
    const off = buildApp({});
    expect((await off.request("/doc")).status).toBe(404);
    expect((await off.request("/doc", bearer("tok-admin"))).status).toBe(404);
    expect(routes(off)).toEqual(
      routes(buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "disabled" })),
    );
    expect(routes(off).some((r) => r.endsWith("/doc"))).toBe(false);
  });

  it("flag on adds exactly one route", () => {
    const on = routes(buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "enabled" }));
    expect(on.filter((r) => !routes(buildApp({})).includes(r))).toEqual([
      "GET /doc",
    ]);
  });

  it("flag on: no credential -> 401", async () => {
    const app = buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "enabled" });
    expect((await app.request("/doc")).status).toBe(401);
    expect((await app.request("/doc", bearer("nope"))).status).toBe(401);
  });

  it("flag on: platform.read serves the platform spec byte-for-byte", async () => {
    const app = buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "enabled" });
    const res = await app.request("/doc", bearer("tok-read"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const text = await res.text();
    expect(text).toBe(`${JSON.stringify(buildPlatformAdminSpec(), null, 2)}\n`);
    const doc = JSON.parse(text) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi.startsWith("3.1")).toBe(true);
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/coding"))).toBe(
      false,
    );
  });

  it("flag on: *, platform.ops and agent keys succeed", async () => {
    const app = buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "enabled" });
    for (const t of ["tok-admin", "tok-ops", "tok-agent"]) {
      expect((await app.request("/doc", bearer(t))).status).toBe(200);
    }
  });

  it("matches the committed platform spec file", async () => {
    const app = buildApp({ SHIPWRIGHT_ADMIN_DOC_ENABLED: "enabled" });
    const res = await app.request("/doc", bearer("tok-read"));
    const committed = await Bun.file(
      new URL("../openapi.platform.json", import.meta.url),
    ).text();
    expect(await res.text()).toBe(committed);
  });
});
