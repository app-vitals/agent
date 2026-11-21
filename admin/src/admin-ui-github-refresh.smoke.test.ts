/**
 * admin/src/admin-ui-github-refresh.smoke.test.ts
 * GLC-2.4: the Refresh button on the agent GitHub card and its POST route:
 * admin only, redirects at once, and makes no GitHub call (the enterprise API
 * is a stub that records paths). No DB, no network.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  makeMockDeps,
  makeSessionCookie,
} from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function setup(refreshStatus = 202) {
  const paths: string[] = [];
  const deps = makeMockDeps({
    githubEnterpriseApi: (path: string, init?: RequestInit) => {
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/github-enterprise/refresh") {
        return refreshStatus === 202
          ? json({ status: "accepted", snapshots: 1, accessPairs: 0 }, 202)
          : json({ error: "nope" }, refreshStatus);
      }
      return json({
        configured: true,
        installer: { role: "installer" },
        lookup: { role: "lookup" },
      });
    },
    agentsApi: () => json({ appId: 1, orgs: [] }),
  } as never);
  return { app: createAdminUIApp(deps), paths };
}

describe("admin UI — GitHub cache Refresh (GLC-2.4)", () => {
  let admin: string;
  let member: string;
  beforeAll(async () => {
    admin = await makeSessionCookie();
    member = await makeSessionCookie(
      undefined,
      "sub-2",
      "other@example.com",
      false,
    );
  });
  const h = (cookie: string) => ({ Cookie: `admin_session=${cookie}` });
  const refresh = (app: ReturnType<typeof setup>["app"], c = admin) =>
    app.request(`/admin/agents/${AGENT_ID}/github-cache/refresh`, {
      method: "POST",
      headers: h(c),
      redirect: "manual",
    });

  it("shows the Refresh button on the agent GitHub card", async () => {
    const { app } = setup();
    const html = await (
      await app.request(`/admin/agents/${AGENT_ID}/access`, {
        headers: h(admin),
      })
    ).text();
    expect(html).toContain('id="github-refresh-btn"');
    expect(html).toContain(`/admin/agents/${AGENT_ID}/github-cache/refresh`);
  });

  it("redirects an admin with 302 after one refresh call", async () => {
    const { app, paths } = setup();
    const res = await refresh(app);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "success=github_refresh_requested",
    );
    expect(paths).toEqual(["POST /github-enterprise/refresh"]);
  });

  it("redirects with an error when the API refuses", async () => {
    const { app } = setup(503);
    const res = await refresh(app);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
  });

  it("is forbidden for a non-admin and calls nothing", async () => {
    const { app, paths } = setup();
    expect((await refresh(app, member)).status).toBe(403);
    expect(paths).toEqual([]);
  });
});
