/**
 * admin/src/admin-ui-templates.smoke.test.ts
 * Smoke tests for /admin/settings/templates (ATP-2.3) via app.request(), over
 * a stateful in-memory template service that reuses the real item validation
 * (denylist, payload shapes) and secret masking. No DB, no network.
 */

import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import { registerAdminTemplatesRoutes } from "./admin-ui-templates.ts";
import {
  type AgentTemplateService,
  normalizeTemplateItem,
  SECRET_MASK,
  type TemplateActor,
  type TemplateItemInput,
  type TemplateView,
} from "./agent-templates.ts";
import type { CallerScope } from "./caller-scope.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";

const now = new Date("2026-11-14T00:00:00Z");
const SPECIALTIES = ["specialist", "reviewer"];

function fakeService() {
  const rows: TemplateView[] = [];
  const secrets = new Map<string, string>();
  let seq = 0;
  const mask = (t: TemplateView): TemplateView => t;
  const apply = (t: TemplateView, raw: TemplateItemInput) => {
    const item = normalizeTemplateItem(raw);
    const payload = { ...item.payload };
    if (item.kind === "env" && payload.secret === true) {
      secrets.set(`${t.id}:${item.key}`, String(payload.value));
      payload.value = SECRET_MASK;
    }
    t.items = [
      ...t.items.filter((i) => !(i.kind === item.kind && i.key === item.key)),
      { kind: item.kind, key: item.key, payload, updatedAt: now },
    ];
  };
  const visible = (a: TemplateActor, t: TemplateView) =>
    a.kind === "admin" || t.accountId === a.accountId;
  const service: Pick<
    AgentTemplateService,
    "list" | "replace" | "putItem" | "deleteItem" | "delete"
  > = {
    async list(actor, f = {}) {
      return rows
        .filter((t) => visible(actor, t))
        .filter((t) => f.accountId === undefined || t.accountId === f.accountId)
        .filter((t) => f.specialty === undefined || t.specialty === f.specialty)
        .map(mask);
    },
    async replace(actor, scope, items) {
      const accountId =
        actor.kind === "account" ? actor.accountId : (scope.accountId ?? null);
      const specialty = scope.specialty ?? null;
      if (specialty !== null && !SPECIALTIES.includes(specialty)) {
        throw new UnprocessableEntityError(`unknown specialty ${specialty}`);
      }
      const t: TemplateView = {
        id: `t${++seq}`,
        accountId,
        specialty,
        createdAt: now,
        updatedAt: now,
        items: [],
      };
      for (const i of items) apply(t, i);
      rows.push(t);
      return { template: t, created: true };
    },
    async putItem(actor, id, input) {
      const t = rows.find((r) => r.id === id && visible(actor, r));
      if (!t) throw new NotFoundError("nope");
      apply(t, input);
      return t;
    },
    async deleteItem(actor, id, kind, key) {
      const t = rows.find((r) => r.id === id && visible(actor, r));
      if (!t) throw new NotFoundError("nope");
      t.items = t.items.filter((i) => !(i.kind === kind && i.key === key));
    },
    async delete(actor, id) {
      const i = rows.findIndex((r) => r.id === id && visible(actor, r));
      if (i < 0) throw new NotFoundError("nope");
      rows.splice(i, 1);
    },
  };
  return { service, rows, secrets };
}

function setup(
  opts: { isAdmin?: boolean; scope?: CallerScope } = {},
): { app: Hono<AdminUIEnv> } & ReturnType<typeof fakeService> {
  const svc = fakeService();
  const app = new Hono<AdminUIEnv>();
  const requireAuth = (async (c, next) => {
    c.set("userEmail", "u@x.com");
    c.set("isAdmin", opts.isAdmin ?? true);
    await next();
  }) as MiddlewareHandler<AdminUIEnv>;
  registerAdminTemplatesRoutes(app, {
    requireAuth,
    templateService: svc.service,
    callerScopeResolver: async () =>
      opts.scope ?? { kind: "scoped", accountId: null, agentIds: [] },
    accounts: {
      listWithCounts: async () =>
        [
          { id: "acct-1", name: "Acme" },
          { id: "acct-2", name: "Globex" },
        ] as never,
      getWithCounts: async (id: string) =>
        ({ id, name: id === "acct-1" ? "Acme" : "Globex" }) as never,
    },
    specialtyRegistry: {
      listTypes: () =>
        SPECIALTIES.map((name) => ({ name, displayName: `Type ${name}` })),
    },
    html: (content, o) =>
      new Response(content, {
        status: o?.status ?? 200,
        headers: { "Content-Type": "text/html" },
      }),
  });
  return { app, ...svc };
}

const BASE = "/admin/settings/templates";
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const member: CallerScope = {
  kind: "scoped",
  accountId: "acct-1",
  agentIds: [],
};

describe("/admin/settings/templates smoke", () => {
  it("renders the page with the scope picker for an admin", async () => {
    const { app } = setup();
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Deployment-wide");
    expect(html).toContain("Acme");
    expect(html).toContain("Globex");
    expect(html).toContain("All agent types");
    expect(html).toContain("Type reviewer");
  });

  it("creates a deployment-wide secret env var and shows it masked", async () => {
    const { app, rows, secrets } = setup();
    const res = await app.request(
      `${BASE}/items`,
      form({
        accountId: "",
        specialty: "",
        kind: "env",
        key: "API_KEY",
        value: "s3cr3t",
        secret: "1",
      }),
    );
    expect(res.status).toBe(302);
    expect(rows[0]).toMatchObject({ accountId: null, specialty: null });
    expect(secrets.get("t1:API_KEY")).toBe("s3cr3t");
    const page = await app.request(res.headers.get("location") as string);
    const html = await page.text();
    expect(html).toContain("API_KEY");
    expect(html).toContain('value="***"');
    expect(html).not.toContain("s3cr3t");
  });

  it("updates, then removes an item, then deletes the template", async () => {
    const { app, rows } = setup();
    const scope = { accountId: "acct-2", specialty: "reviewer" };
    await app.request(
      `${BASE}/items`,
      form({ ...scope, kind: "tool", key: "Bash", enabled: "1" }),
    );
    await app.request(
      `${BASE}/items`,
      form({ ...scope, kind: "plugin", key: "p@m", version: "1.2" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.items.map((i) => i.key).sort()).toEqual(["Bash", "p@m"]);
    const rm = await app.request(
      `${BASE}/items/delete`,
      form({ ...scope, kind: "tool", key: "Bash" }),
    );
    expect(rm.status).toBe(302);
    expect(rows[0]?.items.map((i) => i.key)).toEqual(["p@m"]);
    const del = await app.request(`${BASE}/delete`, form(scope));
    expect(del.status).toBe(302);
    expect(rows).toHaveLength(0);
  });

  it("creates a cron item", async () => {
    const { app, rows } = setup();
    await app.request(
      `${BASE}/items`,
      form({
        accountId: "",
        specialty: "",
        kind: "cron",
        key: "digest",
        schedule: "0 9 * * *",
        prompt: "Summarize",
        enabled: "1",
      }),
    );
    expect(rows[0]?.items[0]).toMatchObject({
      kind: "cron",
      key: "digest",
      payload: { schedule: "0 9 * * *", prompt: "Summarize", enabled: true },
    });
  });

  it("shows a denylisted env key error inline", async () => {
    const { app, rows } = setup();
    const res = await app.request(
      `${BASE}/items`,
      form({
        accountId: "",
        specialty: "",
        kind: "env",
        key: "SLACK_BOT_TOKEN",
        value: "x",
      }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("per-agent credential");
    expect(rows).toHaveLength(0);
  });

  it("shows an unknown specialty error inline", async () => {
    const { app } = setup();
    const res = await app.request(
      `${BASE}/items`,
      form({
        accountId: "",
        specialty: "ghost",
        kind: "tool",
        key: "Bash",
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("unknown specialty ghost");
  });

  it("offers an account member only their own account", async () => {
    const { app } = setup({ isAdmin: false, scope: member });
    const html = await (await app.request(BASE)).text();
    expect(html).toContain("Acme");
    expect(html).not.toContain("Globex");
    expect(html).not.toContain("Deployment-wide");
  });

  it("pins member writes to their account and rejects other accounts", async () => {
    const { app, rows } = setup({ isAdmin: false, scope: member });
    const ok = await app.request(
      `${BASE}/items`,
      form({ accountId: "", specialty: "", kind: "tool", key: "Bash" }),
    );
    expect(ok.status).toBe(302);
    expect(rows[0]?.accountId).toBe("acct-1");
    const other = await app.request(
      `${BASE}/items`,
      form({ accountId: "acct-2", specialty: "", kind: "tool", key: "Bash" }),
    );
    expect(other.status).toBe(403);
    expect((await app.request(`${BASE}?accountId=acct-2`)).status).toBe(403);
  });

  it('shows a "from Helm values" badge only on seeded items (TMK-3.2)', async () => {
    const { app, rows } = setup();
    rows.push({
      id: "t-seed",
      accountId: null,
      specialty: null,
      createdAt: now,
      updatedAt: now,
      items: [
        {
          kind: "plugin",
          key: "seeded@example-plugins",
          payload: {},
          updatedAt: now,
          managedBy: "helm",
        },
        {
          kind: "plugin",
          key: "manual@example-plugins",
          payload: {},
          updatedAt: now,
        },
      ],
    });
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/from Helm values/g)).toHaveLength(1);
    const seeded = html.slice(
      html.indexOf('data-key="seeded@example-plugins"'),
      html.indexOf('data-key="manual@example-plugins"'),
    );
    expect(seeded).toContain("from Helm values");
    // Still editable: the seeded row keeps its Save and Remove buttons.
    expect(seeded).toContain("Save");
    expect(seeded).toContain("Remove");
  });

  it("403s a non-admin without an account", async () => {
    const { app } = setup({ isAdmin: false });
    expect((await app.request(BASE)).status).toBe(403);
    expect(
      (await app.request(`${BASE}/items`, form({ kind: "tool", key: "x" })))
        .status,
    ).toBe(403);
  });
});

describe("/admin/settings/templates marketplace items (TMK-3.1)", () => {
  const scope = { accountId: "", specialty: "" };

  it("creates a marketplace item with name, source and ref and lists it", async () => {
    const { app, rows } = setup();
    const res = await app.request(
      `${BASE}/items`,
      form({
        ...scope,
        kind: "marketplace",
        key: "acme-plugins",
        source: "acme/plugins",
        ref: "v1",
      }),
    );
    expect(res.status).toBe(302);
    expect(rows[0]?.items[0]).toMatchObject({
      kind: "marketplace",
      key: "acme-plugins",
      payload: { source: "acme/plugins", ref: "v1" },
    });
    const html = await (await app.request(BASE)).text();
    expect(html).toContain('data-kind="marketplace" data-key="acme-plugins"');
    expect(html).toContain('value="acme/plugins"');
    expect(html).toContain('value="v1"');
  });

  it("stores an empty ref as null", async () => {
    const { app, rows } = setup();
    await app.request(
      `${BASE}/items`,
      form({
        ...scope,
        kind: "marketplace",
        key: "m",
        source: "acme/plugins",
        ref: "",
      }),
    );
    expect(rows[0]?.items[0]?.payload).toMatchObject({ ref: null });
  });

  it("shows an invalid source as an inline 422 and creates nothing", async () => {
    const { app, rows } = setup();
    const res = await app.request(
      `${BASE}/items`,
      form({
        ...scope,
        kind: "marketplace",
        key: "m",
        source: "/etc/passwd",
        ref: "",
      }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("source must be a GitHub");
    expect(rows).toHaveLength(0);
  });

  it("removes a marketplace item", async () => {
    const { app, rows } = setup();
    await app.request(
      `${BASE}/items`,
      form({
        ...scope,
        kind: "marketplace",
        key: "m",
        source: "acme/plugins",
      }),
    );
    const res = await app.request(
      `${BASE}/items/delete`,
      form({ ...scope, kind: "marketplace", key: "m" }),
    );
    expect(res.status).toBe(302);
    expect(rows[0]?.items).toHaveLength(0);
  });
});
