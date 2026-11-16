/**
 * admin/src/admin-ui-settings-nav-context.smoke.test.ts
 * An extension adminUiRoutes handler receives the viewer-resolved settings nav
 * via getSettingsNav(c), mounted exactly as admin-boot does (after the UI app).
 * Contract: each flag-gated platform item is present iff its route is
 * registered.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountRouteContributions } from "./admin-extension.ts";
import { makeMockDeps, makeSessionCookie } from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import {
  getSettingsNav,
  SETTINGS_ACCOUNT_PATH,
  SETTINGS_ACCOUNTS_PATH,
  SETTINGS_GHE_PATH,
  SETTINGS_TEMPLATES_PATH,
  type SettingsNav,
} from "./admin-ui-settings-layout.ts";

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
const accountServices = (member: string | null) =>
  ({
    accounts: {
      getByMemberEmail: async (e: string) =>
        e === member ? ({ id: "acct-1", name: "Acme" } as never) : null,
      listWithCounts: async () => [],
      getWithCounts: async (id: string) => ({ id, name: "Acme" }),
    },
    members: {},
  }) as never;
const selfServe = {
  enabled: true,
  contactEmail: "c@x.com",
  defaultMaxAgents: 1,
};

const adminCookie = async () => `admin_session=${await makeSessionCookie()}`;

/** Reads the nav from inside an extension route; returns it as JSON. */
async function navSeenByExtension(
  deps: Parameters<typeof makeMockDeps>[0],
  cookie: string,
): Promise<SettingsNav | undefined> {
  const root = new Hono();
  root.route("/", createAdminUIApp(makeMockDeps(deps)));
  const ext = new Hono();
  ext.get("/", (c) => c.json(getSettingsNav(c) ?? null));
  mountRouteContributions(root, [{ path: "/admin/ext-page", app: ext }]);
  const res = await root.request("/admin/ext-page", { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as SettingsNav | null) ?? undefined;
}

const paths = (nav: SettingsNav | undefined) =>
  (nav?.sections ?? []).flatMap((s) => s.items.map((i) => i.path));

describe("getSettingsNav in extension adminUiRoutes", () => {
  it("hands the extension the full nav incl. extension-contributed items", async () => {
    const nav = await navSeenByExtension(
      {
        githubEnterpriseApi: ghe,
        templateService,
        selfServe,
        accountServices: accountServices("admin@example.com"),
        settingsNavItems: [
          { section: "Platform", label: "Ext", path: "/admin/ext-page" },
        ],
      },
      await adminCookie(),
    );
    expect(paths(nav)).toEqual([
      SETTINGS_ACCOUNT_PATH,
      SETTINGS_GHE_PATH,
      SETTINGS_TEMPLATES_PATH,
      SETTINGS_ACCOUNTS_PATH,
      "/admin/ext-page",
    ]);
  });

  it("omits the Account item for a viewer with no account", async () => {
    const nav = await navSeenByExtension(
      { templateService, selfServe, accountServices: accountServices(null) },
      await adminCookie(),
    );
    expect(paths(nav)).not.toContain(SETTINGS_ACCOUNT_PATH);
    expect(paths(nav)).toContain(SETTINGS_ACCOUNTS_PATH);
  });

  it("is undefined outside the admin UI app", async () => {
    const app = new Hono();
    app.get("/", (c) => c.json(getSettingsNav(c) ?? null));
    expect(await (await app.request("/")).json()).toBeNull();
  });
});

describe("contract: nav item present iff its route is registered", () => {
  const cases: Array<{
    name: string;
    deps: Parameters<typeof makeMockDeps>[0];
    path: string;
    present: boolean;
  }> = [
    {
      name: "GHE on",
      deps: { githubEnterpriseApi: ghe },
      path: SETTINGS_GHE_PATH,
      present: true,
    },
    { name: "GHE off", deps: {}, path: SETTINGS_GHE_PATH, present: false },
    {
      name: "Templates on",
      deps: { templateService },
      path: SETTINGS_TEMPLATES_PATH,
      present: true,
    },
    {
      name: "Templates off",
      deps: {},
      path: SETTINGS_TEMPLATES_PATH,
      present: false,
    },
    {
      name: "Accounts on",
      deps: {
        selfServe,
        accountServices: accountServices("admin@example.com"),
      },
      path: SETTINGS_ACCOUNTS_PATH,
      present: true,
    },
    {
      name: "Accounts off",
      deps: {},
      path: SETTINGS_ACCOUNTS_PATH,
      present: false,
    },
  ];
  for (const { name, deps, path, present } of cases) {
    it(`${name}: ${path} ${present ? "present" : "absent"} and route ${present ? "registered" : "404"}`, async () => {
      const cookie = await adminCookie();
      const nav = await navSeenByExtension(deps, cookie);
      expect(paths(nav).includes(path)).toBe(present);
      const app = createAdminUIApp(makeMockDeps(deps));
      const res = await app.request(path, { headers: { cookie } });
      expect(res.status === 404).toBe(!present);
    });
  }
});
