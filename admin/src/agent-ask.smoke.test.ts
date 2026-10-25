/**
 * admin/src/agent-ask.smoke.test.ts
 *
 * POST /agents/{id}/ask and GET /agents/{id}/asks (COS-31.1) over the real
 * admin route table and auth middleware, with an in-memory ChatClient fake,
 * an in-memory audit store and a fixed clock whose sleep advances time.
 * Uses app.request() — no real server, no real DB, no real chat service.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentAskStore, AskAuditRow } from "./agent-ask.ts";
import { parseAgentAskConfig } from "./agent-ask-config.ts";
import {
  type AdminDeps,
  createAdminApp,
  parseAdminApiKeys,
} from "./agents-api.ts";
import type { ChatMessage, ChatThread } from "./http-chat-client.ts";

const FROM = "agent-from";
const TO = "agent-to";
const QUESTION = "what is the deploy status of the secret-project?";

const ADMIN = "admin-key";
const READ = "platform-read-token";
const OPS = "platform-ops-token";
const FROM_KEY = "from-agent-key";
const OTHER_KEY = "other-agent-key";

const START = Date.parse("2026-10-25T12:00:00.000Z");

function fixedClock() {
  let nowMs = START;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: { now: () => new Date(nowMs) },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    threadId: "thread-1",
    role: "user",
    body: "",
    createdAt: new Date(START).toISOString(),
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
    ...over,
  };
}

/** In-memory ChatClient fake; replies on the `replyOnPoll`-th listMessages. */
function fakeChat(replyOnPoll = Number.POSITIVE_INFINITY) {
  const calls: string[] = [];
  const threads: Array<{ agentId: string; opts: unknown }> = [];
  const messages: Array<{ threadId: string; role: string; body: string }> = [];
  let polls = 0;
  const client = {
    async createThread(agentId: string, opts?: unknown): Promise<ChatThread> {
      calls.push("createThread");
      threads.push({ agentId, opts });
      return {
        id: "thread-1",
        agentId,
        title: (opts as { title?: string })?.title ?? null,
        memberId: null,
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
      };
    },
    async createMessage(threadId: string, role: string, body: string) {
      calls.push("createMessage");
      messages.push({ threadId, role, body });
      return message({ id: "msg-user", threadId, role, body });
    },
    async listMessages(threadId: string) {
      calls.push("listMessages");
      polls += 1;
      const replied = polls >= replyOnPoll;
      const list = [
        message({
          id: "msg-user",
          threadId,
          body: QUESTION,
          repliedAt: replied ? new Date(START + 2000).toISOString() : null,
        }),
        ...(replied
          ? [
              message({
                id: "msg-reply",
                threadId,
                role: "assistant",
                body: "deploy is green",
              }),
            ]
          : []),
      ];
      return { messages: list, total: list.length, limit: 50, offset: 0 };
    },
  };
  return { client, calls, threads, messages };
}

function memoryStore(): AgentAskStore & { rows: AskAuditRow[] } {
  const rows: AskAuditRow[] = [];
  return {
    rows,
    async create(input) {
      const row: AskAuditRow = {
        id: `ask-${rows.length + 1}`,
        threadId: null,
        repliedAt: null,
        createdAt: new Date(START),
        ...input,
      };
      rows.push(row);
      return row;
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, patch);
      return row;
    },
    async listForAgent(agentId, { limit, offset }) {
      const matching = rows.filter(
        (r) => r.toAgentId === agentId || r.fromAgentId === agentId,
      );
      return {
        asks: matching.slice(offset, offset + limit),
        total: matching.length,
      };
    },
  };
}

interface Setup {
  enabled?: boolean;
  allowlist?: string;
  chat?: ReturnType<typeof fakeChat> | null;
  store?: ReturnType<typeof memoryStore>;
  time?: ReturnType<typeof fixedClock>;
}

function makeApp(setup: Setup = {}) {
  const chat = setup.chat === undefined ? fakeChat() : setup.chat;
  const store = setup.store ?? memoryStore();
  const time = setup.time ?? fixedClock();
  const deps = {
    agentService: { exists: async (id: string) => id === TO || id === FROM },
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    adminApiKeys: parseAdminApiKeys(
      `root:${ADMIN}:*,reader:${READ}:platform.read,operator:${OPS}:platform.ops,from:${FROM_KEY}:${FROM},other:${OTHER_KEY}:agent-other`,
    ),
    sessionSecret: "s".repeat(32),
    agentAsk: {
      config: parseAgentAskConfig({
        SHIPWRIGHT_AGENT_ASK_ENABLED:
          setup.enabled === false ? undefined : "enabled",
        SHIPWRIGHT_AGENT_ASK_ALLOWLIST: setup.allowlist ?? `${FROM}>${TO}`,
      }),
      store,
      clock: time.clock,
      sleep: time.sleep,
    },
    ...(chat ? { chatClient: chat.client } : {}),
  } as unknown as AdminDeps;
  return { app: createAdminApp(deps), chat, store, time };
}

function ask(
  app: ReturnType<typeof createAdminApp>,
  token: string,
  body: Record<string, unknown> = {},
  to = TO,
) {
  return app.request(`/agents/${to}/ask`, {
    method: "POST",
    body: JSON.stringify({ from: FROM, question: QUESTION, ...body }),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
}

function listAsks(
  app: ReturnType<typeof createAdminApp>,
  token: string,
  query = "",
) {
  return app.request(`/agents/${TO}/asks${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("POST /agents/{id}/ask", () => {
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

  it('flag off → 404 {error:"Not found"}, no chat call', async () => {
    const { app, chat } = makeApp({ enabled: false });
    const res = await ask(app, ADMIN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(chat?.calls).toEqual([]);
    // Even a body that would fail validation is a plain 404.
    const bad = await ask(app, ADMIN, { question: "" });
    expect(bad.status).toBe(404);
    expect((await listAsks(app, ADMIN)).status).toBe(404);
  });

  it("pair not allowlisted → 403 and zero chat calls", async () => {
    const { app, chat, store } = makeApp({ allowlist: `${TO}>${FROM}` });
    const res = await ask(app, ADMIN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "ask not allowed for this pair",
    });
    expect(chat?.calls).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  it("empty allowlist denies every pair", async () => {
    const { app, chat } = makeApp({ allowlist: "" });
    expect((await ask(app, ADMIN)).status).toBe(403);
    expect(chat?.calls).toEqual([]);
  });

  it('depth 2 → 400 {error:"depth is capped at 1"}', async () => {
    const { app, chat } = makeApp();
    const res = await ask(app, ADMIN, { depth: 2 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "depth is capped at 1" });
    expect(chat?.calls).toEqual([]);
  });

  it("waitMs 3000 with a reply on the second poll → replied", async () => {
    const chat = fakeChat(2);
    const { app, store, time } = makeApp({ chat });
    const res = await ask(app, OPS, { waitMs: 3000 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      askId: "ask-1",
      threadId: "thread-1",
      status: "replied",
      reply: "deploy is green",
    });
    expect(chat.threads).toEqual([
      {
        agentId: TO,
        opts: {
          kind: "ask",
          askFromAgentId: FROM,
          askDepth: 1,
          title: `ask from ${FROM} - 2026-10-25T12:00:00.000Z`,
        },
      },
    ]);
    expect(chat.messages).toEqual([
      { threadId: "thread-1", role: "user", body: QUESTION },
    ]);
    expect(chat.calls).toEqual([
      "createThread",
      "createMessage",
      "listMessages",
      "listMessages",
    ]);
    expect(time.sleeps).toEqual([1000, 1000]);
    expect(store.rows[0]).toMatchObject({
      fromAgentId: FROM,
      toAgentId: TO,
      threadId: "thread-1",
      depth: 1,
      waitMs: 3000,
      ttlSeconds: 600,
      status: "replied",
      repliedAt: new Date(START + 2000),
    });
  });

  it("waitMs 0 (default) → pending, no poll", async () => {
    const { app, chat, store } = makeApp();
    const res = await ask(app, ADMIN);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      askId: "ask-1",
      threadId: "thread-1",
      status: "pending",
    });
    expect(chat?.calls).toEqual(["createThread", "createMessage"]);
    expect(store.rows[0]).toMatchObject({ status: "pending", waitMs: 0 });
  });

  it("waitMs budget ends without a reply → pending", async () => {
    const { app, chat, time } = makeApp({ chat: fakeChat() });
    const res = await ask(app, ADMIN, { waitMs: 2500 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("pending");
    expect(time.sleeps).toEqual([1000, 1000, 500]);
    expect(chat?.calls.filter((c) => c === "listMessages")).toHaveLength(3);
  });

  it("the agent key whose id equals from → 201", async () => {
    const { app } = makeApp();
    expect((await ask(app, FROM_KEY)).status).toBe(201);
  });

  it("an agent key with from != its id → 403, no chat call", async () => {
    const { app, chat } = makeApp({ allowlist: `agent-other>${TO}` });
    const res = await ask(app, FROM_KEY, { from: "agent-other" });
    expect(res.status).toBe(403);
    const other = await ask(app, OTHER_KEY);
    expect(other.status).toBe(403);
    expect(chat?.calls).toEqual([]);
  });

  it("platform.read → 403", async () => {
    const { app, chat } = makeApp();
    expect((await ask(app, READ)).status).toBe(403);
    expect(chat?.calls).toEqual([]);
  });

  it("platform.ops → 201", async () => {
    const { app } = makeApp();
    expect((await ask(app, OPS)).status).toBe(201);
  });

  it('chat client absent → 503 {error:"chat service not configured"}', async () => {
    const { app } = makeApp({ chat: null });
    const res = await ask(app, ADMIN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "chat service not configured" });
  });

  it("validates the body bounds", async () => {
    const { app, chat } = makeApp();
    for (const bad of [
      { question: "" },
      { question: "x".repeat(8001) },
      { waitMs: -1 },
      { waitMs: 60001 },
      { ttlSeconds: 59 },
      { ttlSeconds: 3601 },
      { from: "" },
    ]) {
      expect((await ask(app, ADMIN, bad)).status).toBe(400);
    }
    expect(chat?.calls).toEqual([]);
  });

  it("unknown target agent → 404, no chat call", async () => {
    const { app, chat } = makeApp({ allowlist: `${FROM}>ghost` });
    expect((await ask(app, ADMIN, {}, "ghost")).status).toBe(404);
    expect(chat?.calls).toEqual([]);
  });

  it("a chat failure marks the audit row failed", async () => {
    const chat = fakeChat();
    chat.client.createMessage = async () => {
      throw new Error("chat down");
    };
    const { app, store } = makeApp({ chat });
    expect((await ask(app, ADMIN)).status).toBe(500);
    expect(store.rows[0]).toMatchObject({
      status: "failed",
      threadId: "thread-1",
    });
  });

  it("logs one structured line per ask, never the question", async () => {
    const { app } = makeApp({ chat: fakeChat(1) });
    await ask(app, OPS, { waitMs: 1000 });
    const events = logs
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === "agent-ask");
    expect(events).toEqual([
      {
        event: "agent-ask",
        askId: "ask-1",
        from: FROM,
        to: TO,
        status: "replied",
        callerLabel: expect.any(String),
      },
    ]);
    expect(logs.join("\n")).not.toContain(QUESTION);
  });
});

describe("GET /agents/{id}/asks", () => {
  it("lists audit rows for platform.read and above; never the question", async () => {
    const { app } = makeApp();
    expect((await ask(app, ADMIN)).status).toBe(201);
    expect((await ask(app, OPS)).status).toBe(201);
    for (const token of [ADMIN, READ, OPS]) {
      const res = await listAsks(app, token, "?limit=1&offset=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        asks: Array<Record<string, unknown>>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.total).toBe(2);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(1);
      expect(body.asks).toHaveLength(1);
      expect(body.asks[0]).toMatchObject({
        id: "ask-2",
        fromAgentId: FROM,
        toAgentId: TO,
        threadId: "thread-1",
        depth: 1,
        status: "pending",
        createdAt: "2026-10-25T12:00:00.000Z",
        repliedAt: null,
      });
      expect(JSON.stringify(body)).not.toContain(QUESTION);
    }
  });

  it("an agent key → 403", async () => {
    const { app } = makeApp();
    const res = await app.request(`/agents/${FROM}/asks`, {
      headers: { Authorization: `Bearer ${FROM_KEY}` },
    });
    expect(res.status).toBe(403);
  });
});
