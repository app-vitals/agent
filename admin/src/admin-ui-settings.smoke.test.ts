/**
 * admin/src/admin-ui-settings.smoke.test.ts
 * Smoke tests for the settings shell (SGL-2.2): GET /admin/settings redirect,
 * sidebar rendering on GHE + Templates, and the toolbar Settings entry for
 * admins / account members / non-account admins. Via the full admin UI app.
 */

import { describe, expect, it } from "bun:test";
import { makeMockDeps, makeSessionCookie } from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";

const ghe = async () =>
  new Response(
    JSON.stringify({ configured: false, installer: null, lookup: null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const templateService = {
  list: async () => [],
  replace: async () => {
    throw new Error("unused");
  },
  putItem: async () => {
    throw new Error("unused");
  },
  deleteItem: async () => {},
  delete: async () => {},
} as never;

const adminCookie = async () => `admin_session=${await makeSessionCookie()}`;
const userCookie = async (email = "m@acme.com") =>
  `admin_session=${await makeSessionCookie(undefined, "u2", email, false)}`;

const memberAccounts = (member: string | null) =>
  ({
    accounts: {
      getByMemberEmail: async (e: string) =>
        e === member ? ({ id: "acct-1", name: "Acme" } as never) : null,
      listWithCounts: async () => [{ id: "acct-1", name: "Acme" }],
      getWithCounts: async (id: string) => ({ id, name: "Acme" }),
    },
    members: {},
  }) as never;

describe("GET /admin/settings", () => {
  it("redirects an admin to GitHub Enterprise when registered", async () => {
    const app = createAdminUIApp(
      makeMockDeps({ githubEnterpriseApi: ghe, templateService }),
    );
    const res = await app.request("/admin/settings", {
      headers: { cookie: await adminCookie() },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/settings/github-enterprise",
    );
  });

  it("redirects an admin to Templates when only templates are wired", async () => {
    const app = createAdminUIApp(makeMockDeps({ templateService }));
    const res = await app.request("/admin/settings", {
      headers: { cookie: await adminCookie() },
    });
    expect(res.headers.get("location")).toBe("/admin/settings/templates");
  });

  it("redirects a non-admin member past the adminOnly item", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        githubEnterpriseApi: ghe,
        templateService,
        accountServices: memberAccounts("m@acme.com"),
      }),
    );
    const res = await app.request("/admin/settings", {
      headers: { cookie: await userCookie() },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/settings/templates");
  });

  it("404s a non-admin when only admin-only items exist", async () => {
    const app = createAdminUIApp(makeMockDeps({ githubEnterpriseApi: ghe }));
    const res = await app.request("/admin/settings", {
      headers: { cookie: await userCookie() },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No settings");
  });

  it("is not registered without GHE or templates", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/settings", {
      headers: { cookie: await adminCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("requires a session", async () => {
    const app = createAdminUIApp(makeMockDeps({ templateService }));
    const res = await app.request("/admin/settings");
    expect(res.status).not.toBe(200);
    expect(res.headers.get("location") ?? "").not.toBe(
      "/admin/settings/templates",
    );
  });
});

describe("settings shell pages", () => {
  it("renders GHE in the shell with an active sidebar item and no cross-link button", async () => {
    const app = createAdminUIApp(
      makeMockDeps({ githubEnterpriseApi: ghe, templateService }),
    );
    const html = await (
      await app.request("/admin/settings/github-enterprise", {
        headers: { cookie: await adminCookie() },
      })
    ).text();
    expect(html).toContain("settings-sidebar");
    expect(html).toContain(
      'href="/admin/settings/github-enterprise" aria-current="page">GitHub Enterprise',
    );
    expect(html).toContain('href="/admin/settings/templates"');
    expect(html).not.toContain('btn btn-secondary">Agent templates');
    expect(html).toContain(
      'href="/admin/settings" class="vos-nav-link active"',
    );
  });

  it("renders Templates in the shell and hides the GHE item from members", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        githubEnterpriseApi: ghe,
        templateService,
        callerScopeResolver: async () => ({
          kind: "scoped" as const,
          accountId: "acct-1",
          agentIds: [],
        }),
        accountServices: memberAccounts("m@acme.com"),
      }),
    );
    const res = await app.request("/admin/settings/templates", {
      headers: { cookie: await userCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'href="/admin/settings/templates" aria-current="page">Templates',
    );
    expect(html).not.toContain(
      'class="settings-nav-link" href="/admin/settings/github-enterprise"',
    );
  });

  it("lists extension nav items in the sidebar", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        templateService,
        settingsNavItems: [
          { section: "Platform", label: "Widgets", path: "/admin/widgets" },
        ],
      }),
    );
    const html = await (
      await app.request("/admin/settings/templates", {
        headers: { cookie: await adminCookie() },
      })
    ).text();
    expect(html).toContain('href="/admin/widgets"');
  });
});

describe("toolbar Settings entry", () => {
  const settingsLink = 'href="/admin/settings"';
  const get = async (app: ReturnType<typeof createAdminUIApp>, c: string) =>
    (await app.request("/admin/agents", { headers: { cookie: c } })).text();

  it("shows for a non-account admin and for account members, hides for others", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        templateService,
        accountServices: memberAccounts("m@acme.com"),
      }),
    );
    expect(await get(app, await adminCookie())).toContain(settingsLink);
    expect(await get(app, await userCookie("m@acme.com"))).toContain(
      settingsLink,
    );
    expect(await get(app, await userCookie("x@other.com"))).not.toContain(
      settingsLink,
    );
  });
});

describe("GET /admin/settings with accounts (SGL-2.3)", () => {
  const selfServe = { enabled: true, contactEmail: "c@x.com" };
  const build = (member: string | null) =>
    createAdminUIApp(
      makeMockDeps({
        templateService,
        selfServe,
        accountServices: memberAccounts(member),
      } as never),
    );

  it("lands an account member on Account", async () => {
    const res = await build("m@acme.com").request("/admin/settings", {
      headers: { cookie: await userCookie("m@acme.com") },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/account");
  });

  it("skips Account for an admin without an account", async () => {
    const res = await build(null).request("/admin/settings", {
      headers: { cookie: await adminCookie() },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/settings/templates");
  });
});
