/**
 * admin/src/cron-run-now.smoke.test.ts
 *
 * POST /agents/{id}/crons/{cronId}/run-now (COS-42.1) over the real admin
 * route table and auth middleware, with an in-memory store and a fixed clock.
 * Uses app.request() — no real server, no real DB.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import { PLATFORM_OPS_ROUTES } from "./api-auth.ts";
import type {
  CronRunNowStore,
  RunRequestRow,
  RunNowCron,
} from "./cron-run-now.ts";
import { parseCronRunNowConfig } from "./cron-run-now-config.ts";

const AGENT = "agent-a";
const CRON = "cron-1";
const LOCKED = "cron-locked";
const SECRET_PROMPT = "super secret prompt text";

const ADMIN = "admin-key";
const READ = "platform-read-token";
const OPS = "platform-ops-token";
const OWN_KEY = "own-agent-key";
const OTHER_KEY = "other-agent-key";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function memoryStore() {
  const crons = new Map<string, RunNowCron>([
    [CRON, { id: CRON, agentId: AGENT, lockdownDisabledAt: null }],
    [LOCKED, { id: LOCKED, agentId: AGENT, lockdownDisabledAt: NOW }],
  ]);
  const requests: RunRequestRow[] = [];
  const events: string[] = [];
  const store: CronRunNowStore = {
    async findCron(agentId, cronId) {
      const cron = crons.get(cronId);
      return cron && cron.agentId === agentId ? cron : null;
    },
    async recordRequest(input) {
      events.push("record");
      const row: RunRequestRow = {
        id: `req-${requests.length + 1}`,
        status: "requested",
        honouredRunId: null,
        ...input,
      };
      requests.push(row);
      return row;
    },
  };
  return { store, requests, events };
}

function makeApp(opts: { enabled?: boolean } = {}) {
  const mem = memoryStore();
  const deps = {
    agentService: { exists: async () => true },
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    adminApiKeys: parseAdminApiKeys(
      `root:${ADMIN}:*,reader:${READ}:platform.read,operator:${OPS}:platform.ops,own:${OWN_KEY}:${AGENT},other:${OTHER_KEY}:agent-other`,
    ),
    sessionSecret: "s".repeat(32),
    cronRunNow: {
      config: parseCronRunNowConfig({
        SHIPWRIGHT_CRON_RUN_NOW_ENABLED:
          opts.enabled === false ? undefined : "enabled",
      }),
      store: mem.store,
      clock: { now: () => NOW },
    },
  } as unknown as AdminDeps;
  return { app: createAdminApp(deps), ...mem };
}

function runNow(
  app: ReturnType<typeof createAdminApp>,
  token: string,
  init: { body?: string; cron?: string; contentType?: string } = {},
) {
  return app.request(`/agents/${AGENT}/crons/${init.cron ?? CRON}/run-now`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

describe("POST /agents/{id}/crons/{cronId}/run-now", () => {
  let logs: string[];
  const spies: Array<{ mockRestore: () => void }> = [];
  beforeEach(() => {
    logs = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      spies.push(
        spyOn(console, m).mockImplementation((...a: unknown[]) => {
          logs.push(a.map(String).join(" "));
        }),
      );
    }
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("flag off -> 404 for every caller, nothing written", async () => {
    const { app, requests } = makeApp({ enabled: false });
    for (const token of [ADMIN, OPS, OWN_KEY]) {
      const res = await runNow(app, token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(requests).toEqual([]);
  });

  it("any body -> 400, nothing written", async () => {
    const { app, requests } = makeApp();
    for (const init of [
      {
        body: JSON.stringify({ prompt: SECRET_PROMPT }),
        contentType: "application/json",
      },
      { body: "{}", contentType: "application/json" },
      { body: "x", contentType: "text/plain" },
    ]) {
      expect((await runNow(app, ADMIN, init)).status).toBe(400);
    }
    expect(requests).toEqual([]);
  });

  it("platform-read -> 403; other agent's key -> 403", async () => {
    const { app, requests } = makeApp();
    expect((await runNow(app, READ)).status).toBe(403);
    expect((await runNow(app, OTHER_KEY)).status).toBe(403);
    expect(requests).toEqual([]);
  });

  it("no credentials -> 401", async () => {
    const { app } = makeApp();
    const res = await app.request(`/agents/${AGENT}/crons/${CRON}/run-now`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("admin, platform-ops and the agent's own key -> 202 with an audit row", async () => {
    const { app, requests } = makeApp();
    for (const token of [ADMIN, OPS, OWN_KEY]) {
      const res = await runNow(app, token);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ requestedAt: NOW.toISOString() });
    }
    expect(requests).toHaveLength(3);
    for (const row of requests) {
      expect(row).toMatchObject({
        cronId: CRON,
        agentId: AGENT,
        requestedAt: NOW,
        status: "requested",
      });
      expect(row.requestedBy.length).toBeGreaterThan(0);
    }
  });

  it("writes the audit row before responding", async () => {
    const { app, events } = makeApp();
    const res = await runNow(app, ADMIN);
    expect(res.status).toBe(202);
    expect(events).toEqual(["record"]);
  });

  it("lockdown-disabled cron -> 409", async () => {
    const { app, requests } = makeApp();
    const res = await runNow(app, ADMIN, { cron: LOCKED });
    expect(res.status).toBe(409);
    expect(requests).toEqual([]);
  });

  it("unknown cron -> 404", async () => {
    const { app } = makeApp();
    expect((await runNow(app, ADMIN, { cron: "nope" })).status).toBe(404);
  });

  it("logs one structured cron-run-now line and never the prompt", async () => {
    const { app } = makeApp();
    await runNow(app, ADMIN, {
      body: JSON.stringify({ prompt: SECRET_PROMPT }),
      contentType: "application/json",
    });
    await runNow(app, OPS);
    const lines = logs.filter((l) => l.includes('"cron-run-now"'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({
      event: "cron-run-now",
      agentId: AGENT,
      cronId: CRON,
    });
    expect(logs.join("\n")).not.toContain(SECRET_PROMPT);
  });

  it("is on PLATFORM_OPS_ROUTES", () => {
    expect(PLATFORM_OPS_ROUTES.map((r) => `${r.method} ${r.path}`)).toContain(
      "POST /agents/{id}/crons/{cronId}/run-now",
    );
  });
});
