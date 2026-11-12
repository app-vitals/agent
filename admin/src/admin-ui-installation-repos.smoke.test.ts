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
      expect(html).toContain('data-action="lost-access-preview"');
    });

    it("shows a distinct reason for an unbound username", async () => {
      const { app } = setup({
        username: null,
        agentsApi: () => json(INSTALLED),
      });
      const html = await (await get(app, "/github-installation")).text();
      expect(html).toContain('data-reason="no-username"');
      expect(html).not.toContain('data-action="lost-access-preview"');
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

  describe("add and remove", () => {
    it("proxies add and renders the audit", async () => {
      const { app, calls } = setup({
        agentsApi: () =>
          json({ status: "applied", auditId: "aud-1", repos: ["acme/new"] }),
      });
      const res = await post(app, "/github-installation/repos/add", {
        repos: ["acme/new", 5],
      });
      const html = await res.text();
      const c = calls.at(-1);
      expect(c?.path).toBe(`/agents/${AGENT_ID}/github-installation/repos`);
      expect(JSON.parse(String(c?.init?.body))).toEqual({
        repos: ["acme/new"],
      });
      expect(html).toContain("Added to the installation");
      expect(html).toContain("aud-1");
    });

    it("proxies remove and surfaces an API error", async () => {
      const ok = setup({
        agentsApi: () =>
          json({ status: "applied", auditId: "aud-2", repos: ["acme/web"] }),
      });
      const res = await post(ok.app, "/github-installation/repos/remove", {
        repos: ["acme/web"],
      });
      expect(ok.calls.at(-1)?.path).toBe(
        `/agents/${AGENT_ID}/github-installation/repos/remove`,
      );
      expect(await res.text()).toContain("Removed from the installation");

      const bad = setup({
        agentsApi: () => json({ error: "App not installed on org" }, 409),
      });
      const err = await post(bad.app, "/github-installation/repos/remove", {
        repos: ["x/y"],
      });
      expect(err.status).toBe(409);
      expect(await err.text()).toContain("App not installed on org");
    });

    it("is forbidden for a non-admin", async () => {
      const { app, calls } = setup({});
      const res = await post(
        app,
        "/github-installation/repos/add",
        { repos: ["a/b"] },
        member,
      );
      expect(res.status).toBe(403);
      expect(calls.length).toBe(0);
    });
  });

  describe("remove-lost-access confirm flow", () => {
    const work = [
      { id: "acme/api#12", repo: "acme/api", title: "Fix <thing>" },
      { id: "task-9", repo: "acme/api" },
    ];
    const preview = (over: Record<string, unknown> = {}) => ({
      status: "previewed",
      repos: ["acme/api"],
      installationRemoves: ["acme/api"],
      configRemoves: ["acme/api"],
      skippedOrgs: [],
      openWork: work,
      warnings: [],
      ...over,
    });

    it("lists what will be removed and the affected work, linked", async () => {
      const { app, calls } = setup({ agentsApi: () => json(preview()) });
      const res = await get(app, "/github-lost-access/preview");
      const html = await res.text();
      expect(calls.at(-1)?.path).toBe(
        `/agents/${AGENT_ID}/github-lost-access/preview`,
      );
      expect(html).toContain("These 1 repos will be removed");
      expect(html).toContain('href="https://github.com/acme/api/pull/12"');
      expect(html).toContain("Fix &lt;thing&gt;");
      expect(html).toContain("task-9");
      expect(html).toContain("will be blocked");
      expect(html).toContain('id="github-lost-access-apply-btn"');
      expect(html).not.toContain("github-lost-access-confirm-cap");
    });

    it("says so when no open work is affected", async () => {
      const { app } = setup({
        agentsApi: () => json(preview({ openWork: [] })),
      });
      const html = await (await get(app, "/github-lost-access/preview")).text();
      expect(html).toContain('data-open-work="none"');
      expect(html).toContain("No open tasks or PRs would be blocked");
    });

    it("shows a preview warning and skipped orgs", async () => {
      const { app } = setup({
        agentsApi: () =>
          json(
            preview({
              openWork: [],
              warnings: ["open work could not be listed: boom"],
              skippedOrgs: [{ org: "partial-org", reason: "partial listing" }],
            }),
          ),
      });
      const html = await (await get(app, "/github-lost-access/preview")).text();
      expect(html).toContain("open work could not be listed: boom");
      expect(html).toContain("partial-org");
      expect(html).toContain("partial listing");
    });

    it("asks for the extra confirmation over the cap", async () => {
      const repos = Array.from({ length: 11 }, (_, i) => `acme/r${i}`);
      const { app } = setup({
        agentsApi: () =>
          json(preview({ repos, installationRemoves: repos, openWork: [] })),
      });
      const html = await (await get(app, "/github-lost-access/preview")).text();
      expect(html).toContain('id="github-lost-access-confirm-cap"');
      expect(html).toContain('data-over-cap="true"');
    });

    it("renders a skipped preview as a reason", async () => {
      const { app } = setup({
        agentsApi: () =>
          json({ status: "skipped", reason: "GitHub user not found" }),
      });
      const html = await (await get(app, "/github-lost-access/preview")).text();
      expect(html).toContain("GitHub user not found");
      expect(html).not.toContain("github-lost-access-apply-btn");
    });

    it("remove sends the confirmed repos and shows the audit and blocked work", async () => {
      const { app, calls } = setup({
        agentsApi: (_path, init) =>
          init?.method === "POST"
            ? json({
                status: "applied",
                auditId: "aud-7",
                repos: ["acme/api"],
                notRemoved: [{ repo: "acme/web", reason: "still pushable" }],
                warnings: [],
              })
            : json(preview()),
      });
      const res = await post(app, "/github-lost-access/remove", {
        repos: ["acme/api"],
        confirmRemovals: true,
      });
      const html = await res.text();
      const removeCall = calls.find((c) => c.init?.method === "POST");
      expect(removeCall?.path).toBe(
        `/agents/${AGENT_ID}/github-lost-access/remove`,
      );
      expect(JSON.parse(String(removeCall?.init?.body))).toEqual({
        repos: ["acme/api"],
        confirmRemovals: true,
      });
      expect(html).toContain("aud-7");
      expect(html).toContain("were blocked");
      expect(html).toContain('href="https://github.com/acme/api/pull/12"');
      expect(html).toContain("still pushable");
    });

    it("does not claim work blocked when the block failed", async () => {
      const { app } = setup({
        agentsApi: (_p, init) =>
          init?.method === "POST"
            ? json({
                status: "applied",
                auditId: "aud-8",
                repos: ["acme/api"],
                warnings: ["open work for acme/api was not blocked: boom"],
              })
            : json(preview()),
      });
      const html = await (
        await post(app, "/github-lost-access/remove", { repos: ["acme/api"] })
      ).text();
      expect(html).toContain("No open tasks or PRs were blocked");
      expect(html).toContain("was not blocked: boom");
    });

    it("surfaces the over-cap 422 from the API", async () => {
      const { app } = setup({
        agentsApi: (_p, init) =>
          init?.method === "POST"
            ? json({ error: "11 repos would be removed" }, 422)
            : json(preview()),
      });
      const res = await post(app, "/github-lost-access/remove", {
        repos: ["acme/api"],
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("11 repos would be removed");
    });

    it("is forbidden for a non-admin", async () => {
      const { app, calls } = setup({});
      expect(
        (await get(app, "/github-lost-access/preview", member)).status,
      ).toBe(403);
      expect(
        (await post(app, "/github-lost-access/remove", { repos: [] }, member))
          .status,
      ).toBe(403);
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
