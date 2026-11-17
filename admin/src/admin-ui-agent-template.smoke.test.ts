/**
 * admin/src/admin-ui-agent-template.smoke.test.ts
 * Smoke tests for the ATP-2.4 agent template UI via app.request(): inherited /
 * custom badges on the agent page, detach / reattach, reset to template, and
 * the provisioning form's template defaults and opt-out. In-memory doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  MOCK_CRON,
  MOCK_TOOL,
  makeMockDeps,
  makeSessionCookie,
} from "./admin-ui.fixtures.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { resolveDefaultSpecialtyName } from "./specialty-types.ts";
import type { TemplateView } from "./agent-templates.ts";

const TYPE = resolveDefaultSpecialtyName();
const d = new Date("2024-01-01");

let cookie: string;
beforeAll(async () => {
  cookie = await makeSessionCookie();
});

interface ApiCall {
  path: string;
  method: string;
  body: unknown;
}

/** In-memory stand-in for the agents API app's `request`. */
function fakeAgentsApi(opts: { status?: number } = {}) {
  const calls: ApiCall[] = [];
  const api = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const status = opts.status ?? 200;
    return status === 200
      ? Response.json({ ok: true })
      : Response.json({ error: "agent is detached" }, { status });
  };
  return { api, calls };
}

function detailDeps(
  over: {
    detached?: boolean;
    agentsApi?: ReturnType<typeof fakeAgentsApi>["api"];
  } = {},
) {
  const base = makeMockDeps();
  return makeMockDeps({
    ...(over.agentsApi ? { agentsApi: over.agentsApi } : {}),
    agentService: {
      ...base.agentService,
      getDetail: async () => ({
        ...(await base.agentService.getDetail(AGENT_ID)),
        id: AGENT_ID,
        name: "Test Agent",
        slackId: null,
        selfHosted: false,
        specialty: TYPE,
        createdAt: d,
        updatedAt: d,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
        templateDetached: over.detached ?? false,
      }),
    },
    agentEnvService: {
      ...base.agentEnvService,
      getByAgentId: async () => ({
        env: { TPL_KEY: "a", MINE: "b" },
        secretKeys: [],
        sources: { TPL_KEY: "template", MINE: "custom" },
      }),
    },
    agentToolService: {
      ...base.agentToolService,
      list: async () => [
        { ...MOCK_TOOL, id: "t-tpl", pattern: "Read", source: "template" },
        { ...MOCK_TOOL, id: "t-own", pattern: "Bash(ls:*)", source: "custom" },
      ],
    },
    agentPluginService: {
      ...base.agentPluginService,
      list: async () => [
        {
          id: "p-tpl",
          agentId: AGENT_ID,
          source: "template",
          name: "tpl-plugin",
          version: null,
          enabled: true,
          createdAt: d,
          updatedAt: d,
        },
      ],
    },
    agentCronJobService: {
      ...base.agentCronJobService,
      listWithRunSummary: async () => [
        {
          ...MOCK_CRON,
          id: "c-tpl",
          name: "tpl-cron",
          source: "template",
          lastRun: null,
          runCountToday: 0,
        },
      ],
    },
  });
}

const get = (app: ReturnType<typeof createAdminUIApp>, path: string) =>
  app.request(path, { headers: { Cookie: `admin_session=${cookie}` } });

const post = (
  app: ReturnType<typeof createAdminUIApp>,
  path: string,
  fields: Record<string, string> = {},
) =>
  app.request(path, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `admin_session=${cookie}`,
    },
  });

/** Concatenated HTML of every agent section page (the template UI is spread across them). */
async function allSectionsHtml(
  app: ReturnType<typeof createAdminUIApp>,
): Promise<string> {
  const pages = await Promise.all(
    ["", "/automation", "/configuration", "/extensions"].map(async (s) =>
      (await get(app, `/admin/agents/${AGENT_ID}${s}`)).text(),
    ),
  );
  return pages.join("\n");
}

describe("agent page template badges (ATP-2.4)", () => {
  it("marks every env, tool, plugin and cron as inherited or custom", async () => {
    const { api } = fakeAgentsApi();
    const html = await allSectionsHtml(
      createAdminUIApp(detailDeps({ agentsApi: api })),
    );
    // 1 env + 1 tool + 1 plugin + 1 cron inherited; 1 env + 1 tool custom.
    expect(html.match(/data-source="template"/g)).toHaveLength(4);
    expect(html.match(/data-source="custom"/g)).toHaveLength(2);
    expect(html).toContain("badge-template");
    expect(html).toContain("badge-custom");
  });

  it("shows no template UI when the agents API seam is not wired", async () => {
    const html = await (
      await get(createAdminUIApp(detailDeps()), `/admin/agents/${AGENT_ID}`)
    ).text();
    expect(html).not.toContain("data-source=");
    expect(html).not.toContain("/template/detach");
  });

  it("an inherited env row flips to custom after it is edited", async () => {
    const sources: Record<string, string> = { TPL_KEY: "template" };
    const base = makeMockDeps();
    const { api } = fakeAgentsApi();
    const app = createAdminUIApp(
      makeMockDeps({
        agentsApi: api,
        agentEnvService: {
          ...base.agentEnvService,
          getByAgentId: async () => ({
            env: { TPL_KEY: "v" },
            secretKeys: [],
            sources: { ...sources },
          }),
          // Mirrors AgentEnvService.patch: an explicit write is custom.
          patch: async (_id: string, env: Record<string, string>) => {
            for (const k of Object.keys(env)) sources[k] = "custom";
          },
        },
      }),
    );
    const before = await allSectionsHtml(app);
    expect(before).toContain('data-source="template"');
    await post(app, `/admin/agents/${AGENT_ID}/envs`, {
      key: "TPL_KEY",
      value: "mine",
    });
    const after = await allSectionsHtml(app);
    expect(after).not.toContain('data-source="template"');
    expect(after).toContain('data-source="custom"');
  });
});

describe("detach / reattach (ATP-2.4)", () => {
  it("attached agent offers Detach; POST calls the detach endpoint", async () => {
    const { api, calls } = fakeAgentsApi();
    const app = createAdminUIApp(detailDeps({ agentsApi: api }));
    const html = await allSectionsHtml(app);
    expect(html).toContain(`/admin/agents/${AGENT_ID}/template/detach`);
    expect(html).not.toContain(`/template/reattach`);

    const res = await post(app, `/admin/agents/${AGENT_ID}/template/detach`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain(`/admin/agents/${AGENT_ID}`);
    expect(calls).toEqual([
      {
        path: `/agents/${AGENT_ID}/template/detach`,
        method: "POST",
        body: undefined,
      },
    ]);
  });

  it("detached agent shows a Detached state with Reattach; POST calls the reattach endpoint", async () => {
    const { api, calls } = fakeAgentsApi();
    const app = createAdminUIApp(
      detailDeps({ agentsApi: api, detached: true }),
    );
    const html = await allSectionsHtml(app);
    expect(html).toContain("Detached from template");
    expect(html).toContain(`/admin/agents/${AGENT_ID}/template/reattach`);
    expect(html).not.toContain(`/template/detach`);
    // No per-item reset while detached (the API answers 409).
    expect(html).not.toContain(`/template/reset`);

    const res = await post(app, `/admin/agents/${AGENT_ID}/template/reattach`);
    expect(res.status).toBe(302);
    expect(calls.map((c) => c.path)).toEqual([
      `/agents/${AGENT_ID}/template/reattach`,
    ]);
  });

  it("surfaces an API failure as an error on the agent page", async () => {
    const { api } = fakeAgentsApi({ status: 409 });
    const app = createAdminUIApp(detailDeps({ agentsApi: api }));
    const res = await post(app, `/admin/agents/${AGENT_ID}/template/detach`);
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain(
      "agent is detached",
    );
  });

  it("is 404-safe without the agents API seam", async () => {
    const res = await post(
      createAdminUIApp(detailDeps()),
      `/admin/agents/${AGENT_ID}/template/detach`,
    );
    expect(res.status).toBe(404);
  });
});

describe("reset to template (ATP-2.4)", () => {
  it("custom rows get a per-item reset; template rows do not", async () => {
    const { api } = fakeAgentsApi();
    const html = await allSectionsHtml(
      createAdminUIApp(detailDeps({ agentsApi: api })),
    );
    // custom env MINE and custom tool Bash(ls:*) -> 2 per-item resets, plus
    // the agent-wide reset.
    expect(html.match(/name="kind" value="(env|tool)"/g)).toHaveLength(2);
    expect(html).toContain(`/admin/agents/${AGENT_ID}/template/reset`);
  });

  it("POST with kind and key resets one item", async () => {
    const { api, calls } = fakeAgentsApi();
    const app = createAdminUIApp(detailDeps({ agentsApi: api }));
    const res = await post(app, `/admin/agents/${AGENT_ID}/template/reset`, {
      kind: "env",
      key: "MINE",
    });
    expect(res.status).toBe(302);
    expect(calls).toEqual([
      {
        path: `/agents/${AGENT_ID}/template/reset`,
        method: "POST",
        body: { kind: "env", key: "MINE" },
      },
    ]);
  });

  it("POST without kind/key resets everything", async () => {
    const { api, calls } = fakeAgentsApi();
    const app = createAdminUIApp(detailDeps({ agentsApi: api }));
    await post(app, `/admin/agents/${AGENT_ID}/template/reset`);
    expect(calls[0]?.body).toEqual({});
  });

  it("rejects an unknown kind without calling the API", async () => {
    const { api, calls } = fakeAgentsApi();
    const app = createAdminUIApp(detailDeps({ agentsApi: api }));
    const res = await post(app, `/admin/agents/${AGENT_ID}/template/reset`, {
      kind: "bogus",
      key: "x",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain(
      "Unknown",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("provisioning form (ATP-2.4)", () => {
  const template: TemplateView = {
    id: "t1",
    accountId: null,
    specialty: null,
    createdAt: d,
    updatedAt: d,
    items: [
      {
        kind: "env",
        key: "LOG_LEVEL",
        payload: { value: "debug" },
        updatedAt: d,
      },
      { kind: "tool", key: "Read", payload: {}, updatedAt: d },
    ],
  };
  const templateService = {
    list: async () => [template],
    replace: async () => {
      throw new Error("unused");
    },
    putItem: async () => {
      throw new Error("unused");
    },
    deleteItem: async () => {
      throw new Error("unused");
    },
    delete: async () => {},
  };

  function createDeps() {
    const created: Array<Record<string, unknown>> = [];
    const patched: Array<Record<string, string>> = [];
    const plain = makeMockDeps();
    const deps = makeMockDeps({
      templateService,
      agentService: {
        ...plain.agentService,
        create: async (
          ...args: Parameters<typeof plain.agentService.create>
        ) => {
          created.push(args[0] as unknown as Record<string, unknown>);
          return plain.agentService.create(...args);
        },
      },
      agentEnvService: {
        ...plain.agentEnvService,
        patch: async (_id: string, env: Record<string, string>) => {
          patched.push(env);
        },
      },
    });
    return { deps, created, patched };
  }

  it("shows template-provided values as defaults and an opt-out checkbox", async () => {
    const html = await (
      await get(createAdminUIApp(createDeps().deps), "/admin/agents/new")
    ).text();
    expect(html).toContain('name="templateDetached"');
    expect(html).toContain("LOG_LEVEL");
    expect(html).toContain("debug");
    expect(html).toContain("Read");
    expect(html).toContain('name="env"');
  });

  it("omits the template section when no template service is wired", async () => {
    const html = await (
      await get(createAdminUIApp(makeMockDeps()), "/admin/agents/new")
    ).text();
    expect(html).not.toContain('name="templateDetached"');
  });

  it("opt-out checkbox sends templateDetached:true", async () => {
    const { deps, created } = createDeps();
    const res = await post(createAdminUIApp(deps), "/admin/agents", {
      name: "Test Agent",
      type: TYPE,
      templateDetached: "true",
    });
    expect(res.status).toBe(302);
    expect(created[0]?.templateDetached).toBe(true);
  });

  it("without the checkbox the agent follows the template", async () => {
    const { deps, created } = createDeps();
    await post(createAdminUIApp(deps), "/admin/agents", {
      name: "Test Agent",
      type: TYPE,
    });
    expect(created[0]?.templateDetached).not.toBe(true);
  });

  it("form-entered env values are passed as explicit overrides", async () => {
    const { deps, patched } = createDeps();
    await post(createAdminUIApp(deps), "/admin/agents", {
      name: "Test Agent",
      type: TYPE,
      env: "LOG_LEVEL=info\n# comment\n\nEXTRA = two words",
    });
    expect(patched.some((e) => e.LOG_LEVEL === "info")).toBe(true);
    expect(patched.some((e) => e.EXTRA === "two words")).toBe(true);
  });
});

describe("agent Marketplaces card (TMK-3.1)", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "m-x",
    agentId: AGENT_ID,
    name: "x",
    source: "acme/x",
    ref: null,
    rowSource: "custom",
    enabled: true,
    createdAt: d,
    updatedAt: d,
    ...over,
  });

  function marketplaceApp() {
    const deps = detailDeps({ agentsApi: fakeAgentsApi().api });
    const agentDetail = deps.agentService.getDetail;
    return createAdminUIApp({
      ...deps,
      agentService: {
        ...deps.agentService,
        getDetail: async (id: string) => ({
          ...(await agentDetail(id)),
          bakedMarketplaces: ["baked-mp"],
        }),
      },
      agentMarketplaceService: {
        list: async () => [
          row({ id: "m-tpl", name: "tpl-mp", rowSource: "template" }),
          row({ id: "m-own", name: "own-mp", rowSource: "custom" }),
          row({
            id: "m-dead",
            name: "dead-mp",
            rowSource: "template",
            enabled: false,
          }),
        ],
        upsert: async () => row({}),
        remove: async () => undefined,
      },
    } as never);
  }

  async function card(): Promise<string> {
    const html = await (
      await get(marketplaceApp(), `/admin/agents/${AGENT_ID}/extensions`)
    ).text();
    const start = html.indexOf('id="marketplaces-table"');
    return html.slice(start, html.indexOf("</table>", start));
  }

  const rowHtml = (html: string, name: string) =>
    html
      .slice(html.lastIndexOf("<tr", html.indexOf(`>${name}`)))
      .split("</tr>")[0] ?? "";

  it("badges template and custom rows", async () => {
    const html = await card();
    expect(rowHtml(html, "tpl-mp")).toContain('data-source="template"');
    expect(rowHtml(html, "own-mp")).toContain('data-source="custom"');
  });

  it("marks tombstoned rows disabled", async () => {
    const html = await card();
    const dead = rowHtml(html, "dead-mp");
    expect(dead).toContain('data-disabled="true"');
    expect(dead).toContain(">disabled</span>");
    expect(dead).not.toContain("marketplaces/delete");
    const live = rowHtml(html, "tpl-mp");
    expect(live).not.toContain("data-disabled");
    expect(live).toContain("marketplaces/delete");
  });

  it("still renders baked rows as from image", async () => {
    const html = await card();
    expect(html).toContain('data-baked-marketplace="baked-mp"');
    expect(html).toContain("from image");
    expect(rowHtml(html, "baked-mp")).not.toContain("data-source=");
  });

  it("suggests template-sourced marketplace names for the plugin field, not tombstones", async () => {
    const html = await (
      await get(marketplaceApp(), `/admin/agents/${AGENT_ID}/extensions`)
    ).text();
    const list = html.slice(html.indexOf('id="plugin-marketplaces"'));
    const datalist = list.slice(0, list.indexOf("</datalist>"));
    expect(datalist).toContain('value="tpl-mp"');
    expect(datalist).toContain('value="own-mp"');
    expect(datalist).toContain('value="baked-mp"');
    expect(datalist).not.toContain("dead-mp");
  });
});
