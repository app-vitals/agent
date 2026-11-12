/**
 * admin/src/admin-ui-installation-repos.smoke.test.ts
 * Smoke tests (app.request()) for the IRM-3.2 GitHub Sync card (gating, repos
 * body, the single sync confirm and apply), the repo-removal confirm flow
 * (IRM-1.7) and the installation-coverage flag. The agents API is a stubbed seam; no DB, no network.
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
  /** Enterprise Apps status; default: both installer and lookup configured. */
  enterprise?: unknown;
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
    githubEnterpriseApi: () =>
      json(
        opts.enterprise ?? {
          configured: true,
          installer: { role: "installer" },
          lookup: { role: "lookup" },
        },
      ),
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

describe("admin UI — GitHub sync card (IRM-3.2)", () => {
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
    it("shows the Sync button and no input when both Apps are configured", async () => {
      const { app } = setup({ agentsApi: () => json(INSTALLED) });
      const html = await (await get(app, "")).text();
      expect(html).toContain('id="github-installation-card"');
      expect(html).toContain('id="github-sync-btn"');
      const card = html.slice(html.indexOf('id="github-installation-card"'));
      const cardHtml = card.slice(0, card.indexOf("</script>"));
      expect(cardHtml).not.toContain("<input");
    });

    it("is absent when only the installer App is configured", async () => {
      const { app } = setup({
        enterprise: {
          configured: true,
          installer: { role: "installer" },
          lookup: null,
        },
      });
      const html = await (await get(app, "")).text();
      expect(html).not.toContain("github-installation-card");
    });

    it("is absent when only the lookup App is configured", async () => {
      const { app } = setup({
        enterprise: {
          configured: true,
          installer: null,
          lookup: { role: "lookup" },
        },
      });
      const html = await (await get(app, "")).text();
      expect(html).not.toContain("github-installation-card");
    });

    it("is absent when no App is configured", async () => {
      const { app } = setup({
        enterprise: { configured: false, installer: null, lookup: null },
      });
      const html = await (await get(app, "")).text();
      expect(html).not.toContain("github-installation-card");
    });

    it("shows the missing-App-id reason, not the button, with no GH_APP_ID", async () => {
      const { app } = setup({ env: { FOO: "bar" } });
      const html = await (await get(app, "")).text();
      expect(html).toContain('data-reason="missing-app-id"');
      expect(html).not.toContain('id="github-sync-btn"');
    });

    it("shows the no-username reason, not the button, with no bound user", async () => {
      const { app } = setup({ username: null });
      const html = await (await get(app, "")).text();
      expect(html).toContain('data-reason="no-username"');
      expect(html).not.toContain('id="github-sync-btn"');
    });

    it("has no no-username reason when the Apps are not both configured", async () => {
      const { app } = setup({
        username: null,
        enterprise: { configured: true, installer: null, lookup: null },
      });
      const html = await (await get(app, "")).text();
      expect(html).not.toContain('data-reason="no-username"');
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
      expect(html).not.toContain("<button");
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

  describe("GH_APP_ID mismatch", () => {
    it("is explicit when no installation matches but the Installations card has one", async () => {
      const { app, calls } = setup({
        agentsApi: (path) =>
          path.endsWith("/github-installation/repos")
            ? json({ appId: 123, orgs: [] })
            : json({ snapshot: { installations: [{ slug: "x" }] } }),
      });
      const html = await (await get(app, "/github-installation")).text();
      expect(html).toContain('data-reason="app-id-mismatch"');
      expect(html).not.toContain("not installed on any organization");
      expect(calls.some((c) => c.path.endsWith("/github-installations"))).toBe(
        true,
      );
    });

    it("says not installed when there is no installation at all", async () => {
      const { app } = setup({
        agentsApi: (path) =>
          path.endsWith("/github-installation/repos")
            ? json({ appId: 123, orgs: [] })
            : json({ error: "none" }, 404),
      });
      const html = await (await get(app, "/github-installation")).text();
      expect(html).toContain("not installed on any organization");
      expect(html).not.toContain("app-id-mismatch");
    });
  });

  describe("sync confirm and apply", () => {
    const PREVIEW = {
      status: "previewed",
      appAdds: ["acme/new"],
      appRemoves: ["acme/old"],
      agentRemoves: ["acme/gone"],
      skippedOrgs: [],
      openWork: [{ id: "acme/old#4", repo: "acme/old", title: "Open PR" }],
      warnings: [],
    };
    const api: Api = (path, init) => {
      if (path.endsWith("/github-sync/preview")) return json(PREVIEW);
      if (path.endsWith("/github-sync/apply") && init?.method === "POST") {
        return json({
          status: "applied",
          appAdds: ["acme/new"],
          appRemoves: ["acme/old"],
          agentRemoves: ["acme/gone"],
          notApplied: [],
          skippedOrgs: [],
          warnings: [],
        });
      }
      return json({});
    };

    it("one confirm lists adds, removes, agent removes and blocked work", async () => {
      const { app, calls } = setup({ agentsApi: api });
      const res = await get(app, "/github-sync/confirm");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(calls.at(-1)?.path).toBe(
        `/agents/${AGENT_ID}/github-sync/preview`,
      );
      expect(html).toContain('data-list="app-adds"');
      expect(html).toContain('data-list="app-removes"');
      expect(html).toContain('data-list="agent-removes"');
      expect(html).toContain('href="https://github.com/acme/old/pull/4"');
      expect(html.match(/id="github-sync-confirm-btn"/g)?.length).toBe(1);
    });

    it("shows the reason for a skipped preview", async () => {
      const { app } = setup({
        agentsApi: () => json({ status: "skipped", reason: "user not found" }),
      });
      const html = await (await get(app, "/github-sync/confirm")).text();
      expect(html).toContain("user not found");
      expect(html).not.toContain("github-sync-confirm-btn");
    });

    it("surfaces an API failure on the confirm step", async () => {
      const { app } = setup({
        agentsApi: () => json({ error: "GitHub Apps are not configured" }, 503),
      });
      const res = await get(app, "/github-sync/confirm");
      expect(res.status).toBe(503);
    });

    it("apply posts the confirmed lists once and shows what was blocked", async () => {
      const { app, calls } = setup({ agentsApi: api });
      const res = await post(app, "/github-sync/apply-confirmed", {
        appAdds: ["acme/new"],
        appRemoves: ["acme/old"],
        agentRemoves: ["acme/gone"],
        confirmRemovals: true,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const applies = calls.filter((c) =>
        c.path.endsWith("/github-sync/apply"),
      );
      expect(applies.length).toBe(1);
      expect(JSON.parse(String(applies[0]?.init?.body))).toEqual({
        appAdds: ["acme/new"],
        appRemoves: ["acme/old"],
        agentRemoves: ["acme/gone"],
        confirmRemovals: true,
      });
      expect(html).toContain('data-sync="applied"');
      expect(html).toContain("were blocked");
      expect(html).toContain("acme/old#4");
    });

    it("rejects an invalid repo without calling the API", async () => {
      const { app, calls } = setup({ agentsApi: api });
      const res = await post(app, "/github-sync/apply-confirmed", {
        appAdds: ["nope"],
      });
      expect(res.status).toBe(400);
      expect(calls.length).toBe(0);
    });

    it("shows the over-cap refusal from the API", async () => {
      const { app } = setup({
        agentsApi: (path) =>
          path.endsWith("/github-sync/apply")
            ? json({ error: "11 repos would be removed" }, 422)
            : json(PREVIEW),
      });
      const res = await post(app, "/github-sync/apply-confirmed", {
        appRemoves: ["acme/old"],
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("11 repos would be removed");
    });

    it("both routes are forbidden for a non-admin and make no call", async () => {
      const { app, calls } = setup({});
      expect((await get(app, "/github-sync/confirm", member)).status).toBe(403);
      expect(
        (await post(app, "/github-sync/apply-confirmed", {}, member)).status,
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
