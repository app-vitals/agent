/**
 * admin/src/admin-ui-github-identity.smoke.test.ts
 * Smoke tests (app.request()) for the GHE-2.5 GitHub username form post and
 * access preview on the agent detail page. The GHE-1.3 status and the agents
 * API are stubbed seams; no DB, no network.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { createAdminUIApp } from "./admin-ui.ts";
import {
  AGENT_ID,
  makeMockDeps,
  makeSessionCookie,
} from "./admin-ui.fixtures.ts";
import { resolveDefaultSpecialtyName } from "./specialty-types.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function setup(opts: {
  configured?: boolean;
  agentsApi?: (path: string, init?: RequestInit) => Response;
}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const base = makeMockDeps();
  const deps = makeMockDeps({
    agentService: {
      ...base.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        specialty: resolveDefaultSpecialtyName(),
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
        githubUsername: "octo",
      }),
    },
    githubEnterpriseApi: () => json({ configured: opts.configured ?? true }),
    agentsApi: (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return opts.agentsApi ? opts.agentsApi(path, init) : json({});
    },
  } as never);
  return { app: createAdminUIApp(deps), calls };
}

describe("admin UI — GitHub identity (GHE-2.5)", () => {
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
  const get = (app: ReturnType<typeof setup>["app"], cookie: string) =>
    app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
  const post = (
    app: ReturnType<typeof setup>["app"],
    cookie: string,
    v: string,
  ) =>
    app.request(`/admin/agents/${AGENT_ID}/github-username`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ githubUsername: v }),
    });

  it("shows the row and preview card to an admin when configured", async () => {
    const { app } = setup({});
    const html = await (await get(app, admin)).text();
    expect(html).toContain("Owner &amp; identities");
    expect(html).toContain("GitHub username");
    expect(html).toContain('id="github-access-btn"');
  });

  it("hides both when not configured", async () => {
    const { app } = setup({ configured: false });
    const html = await (await get(app, admin)).text();
    expect(html).not.toContain("GitHub username");
    expect(html).not.toContain("github-access-btn");
  });

  it("hides both from a non-admin", async () => {
    const { app } = setup({});
    const html = await (await get(app, member)).text();
    expect(html).not.toContain("GitHub username");
    expect(html).not.toContain("github-access-btn");
  });

  it("form post PATCHes githubUsername and redirects", async () => {
    const { app, calls } = setup({});
    const res = await post(app, admin, " Octo ");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "success=github_username_saved",
    );
    const c = calls.at(-1);
    expect(c?.path).toBe(`/agents/${AGENT_ID}`);
    expect(c?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(c?.init?.body))).toEqual({
      githubUsername: "Octo",
    });
  });

  it("empty post clears with null", async () => {
    const { app, calls } = setup({});
    const res = await post(app, admin, "");
    expect(res.headers.get("location")).toContain("github_username_cleared");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      githubUsername: null,
    });
  });

  it("surfaces an API validation error", async () => {
    const { app } = setup({
      agentsApi: () => json({ error: "githubUsername must be valid" }, 422),
    });
    const res = await post(app, admin, "-bad");
    expect(res.headers.get("location")).toContain(
      encodeURIComponent("githubUsername must be valid"),
    );
  });

  it("form post is forbidden for a non-admin and makes no call", async () => {
    const { app, calls } = setup({});
    const res = await post(app, member, "octo");
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("preview route calls the access API and renders the table", async () => {
    const { app, calls } = setup({
      agentsApi: () =>
        json({
          status: "ok",
          access: {
            username: "octo",
            outcome: "ok",
            userVerified: true,
            orgs: [
              {
                org: "acme",
                status: "partial",
                unresolved: 1,
                repos: [
                  { fullName: "acme/api", level: "admin", canPush: true },
                ],
              },
            ],
            unresolved: 1,
            complete: false,
            checkedAt: "2026-11-10T00:00:00Z",
          },
        }),
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/github-access`, {
      headers: { Cookie: `admin_session=${admin}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(calls.at(-1)?.path).toBe(`/agents/${AGENT_ID}/github-access`);
    expect(html).toContain("acme/api");
    expect(html).toContain("Partial results");
    expect(html).toContain("Can push");
  });

  it("preview route surfaces an API error (no username bound)", async () => {
    const { app } = setup({
      agentsApi: () => json({ error: "no githubUsername bound" }, 422),
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/github-access`, {
      headers: { Cookie: `admin_session=${admin}` },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("no githubUsername bound");
  });

  it("preview route is forbidden for a non-admin", async () => {
    const { app, calls } = setup({});
    const res = await app.request(`/admin/agents/${AGENT_ID}/github-access`, {
      headers: { Cookie: `admin_session=${member}` },
    });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });
});
