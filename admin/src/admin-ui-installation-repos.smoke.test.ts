/**
 * admin/src/admin-ui-installation-repos.smoke.test.ts
 * Smoke tests (app.request()) for the IRM-1.4 Installation repos card, the
 * lost-access confirm flow, the repo-removal confirm flow (IRM-1.7) and the
 * installation-coverage flag. The agents API is a stubbed seam; no DB, no network.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  makeMockDeps,
  makeSessionCookie,
} from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { resolveDefaultSpecialtyName } from "./specialty-types.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Api = (path: string, init?: RequestInit) => Response;

function setup(opts: {
  env?: Record<string, string>;
  username?: string | null;
  repos?: string[];
  agentsApi?: Api;
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
        repos: opts.repos ?? [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
        githubUsername: opts.username === undefined ? "octo" : opts.username,
      }),
    },
    agentEnvService: {
      ...base.agentEnvService,
      getByAgentId: async () => ({
        env: opts.env ?? { GH_APP_ID: "123" },
        secretKeys: [],
      }),
    },
    githubEnterpriseApi: () => json({ configured: true }),
    agentsApi: (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return opts.agentsApi ? opts.agentsApi(path, init) : json({});
    },
  } as never);
  return { app: createAdminUIApp(deps), calls };
}

const INSTALLED = {
  appId: 123,
  orgs: [
    {
      org: "acme",
      repos: [
        { fullName: "acme/api", userCanPush: true },
        { fullName: "acme/web", userCanPush: false },
        { fullName: "acme/docs" },
      ],
    },
  ],
};

describe("admin UI — installation repos card (IRM-1.4)", () => {
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
  const get = (app: ReturnType<typeof setup>["app"], path: string, c = admin) =>
    app.request(`/admin/agents/${AGENT_ID}${path}`, { headers: h(c) });
  const post = (
    app: ReturnType<typeof setup>["app"],
    path: string,
    body: unknown,
    c = admin,
  ) =>
    app.request(`/admin/agents/${AGENT_ID}${path}`, {
      method: "POST",
      headers: { ...h(c), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("card presence", () => {
    it("is present for an agent with GH_APP_ID", async () => {
      const { app } = setup({ agentsApi: () => json(INSTALLED) });
      const html = await (await get(app, "")).text();
      expect(html).toContain('id="github-installation-card"');
    });

    it("is absent for an agent with no GH_APP_ID", async () => {
      const { app } = setup({ env: { FOO: "bar" } });
      const html = await (await get(app, "")).text();
      expect(html).not.toContain("github-installation-card");
    });

    it("is absent for a non-admin", async () => {
      const { app } = setup({});
      const html = await (await get(app, "", member)).text();
      expect(html).not.toContain("github-installation-card");
    });
  });

  describe("body fragment", () => {
    it("lists repos per org with the push hint only when known", async () => {
      const { app, calls } = setup({ agentsApi: () => json(INSTALLED) });
      const res = await get(app, "/github-installation");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(calls.at(-1)?.path).toBe(
        `/agents/${AGENT_ID}/github-installation/repos`,
      );
      expect(html).toContain('data-org="acme"');
      expect(html).toContain("acme/api");
      expect(html).toContain("user can push");
      expect(html).toContain("user cannot push");
      // acme/docs has no hint: exactly two hint badges
      expect(html.match(/>user can(not)? push</g)?.length).toBe(2);
      expect(html).not.toContain("data-action=");
    });

    it("lists repos for an unbound username without hints", async () => {
      const { app } = setup({
        username: null,
        agentsApi: () => json(INSTALLED),
      });
      const html = await (await get(app, "/github-installation")).text();
      expect(html).toContain("acme/api");
    });

    it("shows a distinct reason for an unconfigured installer App", async () => {
      const { app } = setup({
        agentsApi: () => json({ error: "GitHub Apps are not configured" }, 503),
      });
      const res = await get(app, "/github-installation");
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain('data-reason="installer-unconfigured"');
      expect(html).not.toContain('data-reason="no-username"');
    });

    it("is forbidden for a non-admin and makes no call", async () => {
      const { app, calls } = setup({});
      const res = await get(app, "/github-installation", member);
      expect(res.status).toBe(403);
      expect(calls.length).toBe(0);
    });
  });

  describe("agent repos list", () => {
    const api: Api = (path, init) => {
      if (path.endsWith("/removal-preview")) {
        return json({
          repo: "acme/web",
          openWork: [{ id: "acme/web#3", repo: "acme/web", title: "Open PR" }],
          warnings: [],
        });
      }
      if (init?.method === "DELETE") return json({ id: AGENT_ID });
      return json(INSTALLED);
    };

    it("flags repos the installation does not cover, only as a warning", async () => {
      const { app, calls } = setup({
        repos: ["acme/api", "ACME/Web", "other/gone"],
        agentsApi: api,
      });
      const html = await (await get(app, "")).text();
      expect(html).toContain('id="repos-uncovered-warning"');
      expect(html).toContain("other/gone");
      expect(html.match(/data-uncovered="1"/g)?.length).toBe(1);
      expect(calls.every((c) => c.init?.method !== "DELETE")).toBe(true);
    });

    it("shows no flag when every repo is covered or coverage is unknown", async () => {
      const covered = setup({ repos: ["acme/api"], agentsApi: api });
      expect(await (await get(covered.app, "")).text()).not.toContain(
        "repos-uncovered-warning",
      );
      const unknown = setup({
        repos: ["other/gone"],
        agentsApi: () => json({ error: "x" }, 502),
      });
      expect(await (await get(unknown.app, "")).text()).not.toContain(
        "repos-uncovered-warning",
      );
    });

    it("confirm step lists the affected open work", async () => {
      const { app, calls } = setup({ repos: ["acme/web"], agentsApi: api });
      const res = await get(app, "/repos/removal-confirm?repo=acme/web");
      const html = await res.text();
      expect(calls.at(-1)?.path).toBe(
        `/agents/${AGENT_ID}/repos/acme/web/removal-preview`,
      );
      expect(html).toContain('href="https://github.com/acme/web/pull/3"');
      expect(html).toContain("Open PR");
      expect(html).toContain('id="repo-removal-confirm-btn"');
    });

    it("confirm step with no affected work and with a warning", async () => {
      const none = setup({
        agentsApi: () => json({ repo: "acme/web", openWork: [], warnings: [] }),
      });
      expect(
        await (
          await get(none.app, "/repos/removal-confirm?repo=acme/web")
        ).text(),
      ).toContain('data-open-work="none"');
      const warn = setup({
        agentsApi: () =>
          json({
            repo: "acme/web",
            openWork: [],
            warnings: ["open work could not be listed: boom"],
          }),
      });
      expect(
        await (
          await get(warn.app, "/repos/removal-confirm?repo=acme/web")
        ).text(),
      ).toContain("open work could not be listed: boom");
    });

    it("rejects an invalid repo without calling the API", async () => {
      const { app, calls } = setup({});
      const res = await get(app, "/repos/removal-confirm?repo=nope");
      expect(res.status).toBe(400);
      expect(calls.length).toBe(0);
    });

    it("confirmed removal deletes via the API and shows what was blocked", async () => {
      const { app, calls } = setup({ repos: ["acme/web"], agentsApi: api });
      const res = await post(app, "/repos/remove-confirmed", {
        repo: "acme/web",
      });
      const html = await res.text();
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del?.path).toBe(`/agents/${AGENT_ID}/repos/acme/web`);
      expect(html).toContain("Removed");
      expect(html).toContain("were blocked");
      expect(html).toContain("acme/web#3");
    });

    it("confirm routes are forbidden for a non-admin", async () => {
      const { app, calls } = setup({});
      expect(
        (await get(app, "/repos/removal-confirm?repo=a/b", member)).status,
      ).toBe(403);
      expect(
        (await post(app, "/repos/remove-confirmed", { repo: "a/b" }, member))
          .status,
      ).toBe(403);
      expect(calls.length).toBe(0);
    });
  });
});
