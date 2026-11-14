/**
 * admin/src/agent-templates-api.smoke.test.ts
 * Smoke test for the /templates routes via app.request(): routing, auth and
 * error mapping over an in-memory service. No DB, no network.
 */

import { describe, expect, it } from "bun:test";
import { buildPlatformAdminSpec } from "./admin-spec.ts";
import type { TemplateView } from "./agent-templates.ts";
import { createAgentTemplatesApp } from "./agent-templates-api.ts";
import { parseAdminApiKeys } from "./api-auth.ts";
import { NotFoundError } from "./errors.ts";

const now = new Date("2026-11-14T00:00:00Z");
const view: TemplateView = {
  id: "t1",
  accountId: null,
  specialty: null,
  createdAt: now,
  updatedAt: now,
  items: [
    {
      kind: "env",
      key: "TOKEN",
      payload: { value: "***", secret: true },
      updatedAt: now,
    },
  ],
};

function build() {
  const app = createAgentTemplatesApp({
    templateService: {
      list: async () => [view],
      get: async (_a, id) => {
        if (id !== "t1") throw new NotFoundError("nope");
        return view;
      },
      replace: async () => ({ template: view, created: true }),
      putItem: async () => view,
      deleteItem: async () => {},
      delete: async () => {},
    },
    callerScopeResolver: async () => ({ kind: "all" }),
    sessionSecret: "smoke-session-secret-32-chars-long",
    adminApiKeys: parseAdminApiKeys("root:tok-admin:*,bot:tok-agent:agent-1"),
    agentTokenService: { validate: async () => null },
  });
  return { app };
}

const admin = {
  Authorization: "Bearer tok-admin",
  "Content-Type": "application/json",
};

describe("/templates smoke", () => {
  it("serves every route for an admin", async () => {
    const { app } = build();
    const list = await app.request("/templates", { headers: admin });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { templates: unknown[] }).templates,
    ).toHaveLength(1);

    const get = await app.request("/templates/t1", { headers: admin });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      id: "t1",
      items: [{ payload: { value: "***" } }],
    });

    const put = await app.request("/templates", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ items: [] }),
    });
    expect(put.status).toBe(201);

    const item = await app.request("/templates/t1/items", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ kind: "tool", key: "Bash" }),
    });
    expect(item.status).toBe(200);

    expect(
      (
        await app.request("/templates/t1/items?kind=tool&key=Bash", {
          method: "DELETE",
          headers: admin,
        })
      ).status,
    ).toBe(204);
    expect(
      (await app.request("/templates/t1", { method: "DELETE", headers: admin }))
        .status,
    ).toBe(204);
  });

  it("maps errors and rejects bad auth and bodies", async () => {
    const { app } = build();
    expect(
      (await app.request("/templates/missing", { headers: admin })).status,
    ).toBe(404);
    expect((await app.request("/templates")).status).toBe(401);
    expect(
      (
        await app.request("/templates", {
          headers: { Authorization: "Bearer tok-agent" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/templates", {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({ items: [{ kind: "bogus", key: "x" }] }),
        })
      ).status,
    ).toBe(400);
  });

  it("is documented in the platform OpenAPI spec", () => {
    const spec = buildPlatformAdminSpec();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/templates",
        "/templates/{id}",
        "/templates/{id}/items",
      ]),
    );
  });
});
