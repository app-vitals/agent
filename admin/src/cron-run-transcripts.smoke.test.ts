/**
 * admin/src/cron-run-transcripts.smoke.test.ts
 *
 * PUT/GET /agents/{id}/crons/{cronId}/runs/{runId}/transcript (COS-43.1) over
 * the real admin route table and auth middleware with an in-memory store.
 * Uses app.request() — no real server, no real DB.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import {
  MAX_TRANSCRIPT_BODY_BYTES,
  type TranscriptReadRow,
  type TranscriptRow,
  type TranscriptStore,
} from "./cron-run-transcripts.ts";
import { NotFoundError } from "./errors.ts";
import { parseTranscriptConfig } from "./transcript-config.ts";

const AGENT = "agent-1";
const CRON = "cron-1";
const RUN = "run-1";
const ADMIN = "admin-key";
const READ = "platform-read-token";
const OPS = "platform-ops-token";
const AGENT_KEY = "agent-1-key";
const OTHER_KEY = "agent-2-key";
const SECRET_BODY = "TRANSCRIPT-BODY-MUST-NOT-BE-LOGGED";

function memoryStore() {
  const rows = new Map<string, TranscriptRow>();
  const reads: TranscriptReadRow[] = [];
  const order: string[] = [];
  const store: TranscriptStore = {
    async upsert(input) {
      if (
        input.agentId !== AGENT ||
        input.cronId !== CRON ||
        input.runId !== RUN
      ) {
        throw new NotFoundError(`cron run ${input.runId} not found`);
      }
      const row: TranscriptRow = { ...input, createdAt: new Date(0) };
      rows.set(input.runId, row);
      order.push("upsert");
      return row;
    },
    async get(agentId, cronId, runId) {
      const row = rows.get(runId);
      return row && row.agentId === agentId && row.cronId === cronId
        ? row
        : null;
    },
    async recordRead(row) {
      order.push("recordRead");
      reads.push({ ...row, at: new Date(0) });
    },
  };
  return { store, rows, reads, order };
}

function makeApp(enabled = true, mem = memoryStore()) {
  const deps = {
    agentService: { exists: async () => true },
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    adminApiKeys: parseAdminApiKeys(
      `root:${ADMIN}:*,reader:${READ}:platform.read,operator:${OPS}:platform.ops,a1:${AGENT_KEY}:${AGENT},a2:${OTHER_KEY}:agent-2`,
    ),
    sessionSecret: "s".repeat(32),
    transcripts: {
      config: parseTranscriptConfig({
        SHIPWRIGHT_TRANSCRIPT_API_ENABLED: enabled ? "enabled" : undefined,
      }),
      store: mem.store,
    },
  } as unknown as AdminDeps;
  return { app: createAdminApp(deps), ...mem };
}

const path = (agent = AGENT, cron = CRON, run = RUN) =>
  `/agents/${agent}/crons/${cron}/runs/${run}/transcript`;

function put(
  app: ReturnType<typeof createAdminApp>,
  token: string | null,
  body: Record<string, unknown> = {},
  p = path(),
) {
  return app.request(p, {
    method: "PUT",
    body: JSON.stringify({
      sessionId: "sess-1",
      body: SECRET_BODY,
      truncated: false,
      redactions: 2,
      ...body,
    }),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function get(
  app: ReturnType<typeof createAdminApp>,
  token: string | null,
  p = path(),
) {
  return app.request(p, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("transcript routes — flag", () => {
  it("404s PUT and GET when the flag is off, for every caller", async () => {
    const { app } = makeApp(false);
    expect((await put(app, ADMIN)).status).toBe(404);
    expect((await put(app, AGENT_KEY)).status).toBe(404);
    expect((await get(app, ADMIN)).status).toBe(404);
    expect((await get(app, READ)).status).toBe(404);
  });

  it("404s when no transcript deps are wired at all", async () => {
    const deps = {
      agentService: { exists: async () => true },
      agentTokenService: { validate: async () => null },
      adminApiKeys: parseAdminApiKeys(`root:${ADMIN}:*`),
      sessionSecret: "s".repeat(32),
    } as unknown as AdminDeps;
    const app = createAdminApp(deps);
    expect((await get(app, ADMIN)).status).toBe(404);
  });
});

describe("PUT transcript — auth matrix", () => {
  it("accepts the agent's own key and the admin key", async () => {
    const { app, rows } = makeApp();
    expect((await put(app, AGENT_KEY)).status).toBe(200);
    expect((await put(app, ADMIN)).status).toBe(200);
    expect(rows.get(RUN)?.redactions).toBe(2);
  });

  it("rejects another agent's key, platform keys and anonymous callers", async () => {
    const { app } = makeApp();
    expect((await put(app, OTHER_KEY)).status).toBe(403);
    expect((await put(app, READ)).status).toBe(403);
    expect((await put(app, OPS)).status).toBe(403);
    expect((await put(app, null)).status).toBe(401);
  });

  it("404s when the run is not owned by the cron/agent", async () => {
    const { app } = makeApp();
    expect((await put(app, ADMIN, {}, path(AGENT, "other-cron"))).status).toBe(
      404,
    );
  });

  it("returns the stored size and flags", async () => {
    const { app } = makeApp();
    const res = await put(app, AGENT_KEY, { truncated: true });
    expect(await res.json()).toEqual({
      runId: RUN,
      bytes: Buffer.byteLength(SECRET_BODY),
      truncated: true,
      redactions: 2,
    });
  });
});

describe("PUT transcript — size cap", () => {
  it("accepts exactly 1 MiB and 413s one byte over", async () => {
    const { app } = makeApp();
    const ok = await put(app, AGENT_KEY, {
      body: "a".repeat(MAX_TRANSCRIPT_BODY_BYTES),
    });
    expect(ok.status).toBe(200);
    const big = await put(app, AGENT_KEY, {
      body: "a".repeat(MAX_TRANSCRIPT_BODY_BYTES + 1),
    });
    expect(big.status).toBe(413);
  });

  it("counts bytes, not characters", async () => {
    const { app } = makeApp();
    const res = await put(app, AGENT_KEY, {
      body: "é".repeat(MAX_TRANSCRIPT_BODY_BYTES / 2 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("400s a malformed body", async () => {
    const { app } = makeApp();
    expect((await put(app, AGENT_KEY, { body: 5 })).status).toBe(400);
  });
});

describe("GET transcript — auth matrix and audit", () => {
  it("403s every agent key, even for its own run", async () => {
    const mem = memoryStore();
    const { app, reads } = makeApp(true, mem);
    await put(app, ADMIN);
    expect((await get(app, AGENT_KEY)).status).toBe(403);
    expect((await get(app, OTHER_KEY)).status).toBe(403);
    expect(reads).toHaveLength(0);
  });

  it("401s anonymous callers", async () => {
    const { app } = makeApp();
    expect((await get(app, null)).status).toBe(401);
  });

  it("serves admin, platform.read and platform.ops and audits each read first", async () => {
    const mem = memoryStore();
    const { app, reads, order } = makeApp(true, mem);
    await put(app, AGENT_KEY);
    order.length = 0;
    for (const [token, kind, reader] of [
      [ADMIN, "admin", "root"],
      [READ, "platform-read", "reader"],
      [OPS, "platform-ops", "operator"],
    ] as const) {
      const res = await get(app, token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        runId: RUN,
        cronId: CRON,
        sessionId: "sess-1",
        bytes: Buffer.byteLength(SECRET_BODY),
        truncated: false,
        redactions: 2,
        createdAt: new Date(0).toISOString(),
        body: SECRET_BODY,
      });
      expect(reads.at(-1)).toMatchObject({
        runId: RUN,
        agentId: AGENT,
        scopeKind: kind,
        reader,
      });
    }
    expect(order).toEqual(["recordRead", "recordRead", "recordRead"]);
    expect(reads).toHaveLength(3);
  });

  it("404s an absent transcript and writes no audit row", async () => {
    const { app, reads } = makeApp();
    expect((await get(app, ADMIN)).status).toBe(404);
    expect(reads).toHaveLength(0);
  });

  it("does not respond when the audit write fails", async () => {
    const mem = memoryStore();
    const { app } = makeApp(true, mem);
    await put(app, ADMIN);
    mem.store.recordRead = async () => {
      throw new Error("db down");
    };
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const res = await get(app, ADMIN);
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SECRET_BODY);
  });
});

describe("transcript routes — logging", () => {
  it("never logs the transcript body", async () => {
    const lines: string[] = [];
    const sinks = (["log", "warn", "error", "info"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    const { app } = makeApp();
    await put(app, AGENT_KEY);
    await get(app, ADMIN);
    for (const s of sinks) s.mockRestore();
    expect(lines.join("\n")).not.toContain(SECRET_BODY);
  });
});
