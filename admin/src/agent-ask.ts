/**
 * admin/src/agent-ask.ts
 *
 * Agent-to-agent ask (COS-31.1): POST /agents/{id}/ask posts a question from
 * one agent (`from`) into a new `kind: "ask"` chat thread of the target agent
 * (`{id}`), optionally waits for the reply, and audits every ask in the
 * AgentAsk table. GET /agents/{id}/asks lists the audit rows.
 *
 * Gates, in order: flag (SHIPWRIGHT_AGENT_ASK_ENABLED, 404 when off) → caller
 * (`*`, platform.ops, or the agent key whose id equals `from`) → chat client
 * wired (503) → depth capped at 1 (400) → from>to pair allowlisted (403) →
 * target agent exists (404). Nothing touches the chat service before every
 * gate passed. The question text is never stored or logged.
 */

import { callerLabel } from "@app-vitals/agent-lib/request-context";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { PrismaClient } from "../prisma/client/client.ts";
import { type AgentAskConfig, isAskAllowed } from "./agent-ask-config.ts";
import type { AgentService } from "./agents.ts";
import type { AdminAuthEnv, AdminScope } from "./api-auth.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";
import type { ChatClient, ChatMessage } from "./http-chat-client.ts";
import {
  AgentAskBodySchema,
  AgentAskListSchema,
  AgentAskResponseSchema,
  AgentIdParamSchema,
  ErrorSchema,
  ListAgentAsksQuerySchema,
} from "./openapi-schemas.ts";

// ─── Audit store ──────────────────────────────────────────────────────────────

export type AskStatus = "created" | "pending" | "replied" | "failed";

/** One AgentAsk audit row. No question text, by design. */
export interface AskAuditRow {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  threadId: string | null;
  depth: number;
  waitMs: number;
  ttlSeconds: number;
  status: string;
  callerLabel: string;
  createdAt: Date;
  repliedAt: Date | null;
}

type AskAuditCreate = Pick<
  AskAuditRow,
  | "fromAgentId"
  | "toAgentId"
  | "depth"
  | "waitMs"
  | "ttlSeconds"
  | "status"
  | "callerLabel"
>;

type AskAuditPatch = Partial<
  Pick<AskAuditRow, "threadId" | "status" | "repliedAt">
>;

export interface AgentAskStore {
  create(input: AskAuditCreate): Promise<AskAuditRow>;
  update(id: string, patch: AskAuditPatch): Promise<AskAuditRow>;
  /** Asks the agent sent or received, newest first. */
  listForAgent(
    agentId: string,
    page: { limit: number; offset: number },
  ): Promise<{ asks: AskAuditRow[]; total: number }>;
}

/** Prisma-backed AgentAsk audit store. */
export class AgentAskService implements AgentAskStore {
  constructor(private prisma: Pick<PrismaClient, "agentAsk">) {}

  create(input: AskAuditCreate): Promise<AskAuditRow> {
    return this.prisma.agentAsk.create({ data: input });
  }

  update(id: string, patch: AskAuditPatch): Promise<AskAuditRow> {
    return this.prisma.agentAsk.update({ where: { id }, data: patch });
  }

  async listForAgent(
    agentId: string,
    page: { limit: number; offset: number },
  ): Promise<{ asks: AskAuditRow[]; total: number }> {
    const where = {
      OR: [{ toAgentId: agentId }, { fromAgentId: agentId }],
    };
    const [asks, total] = await Promise.all([
      this.prisma.agentAsk.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: page.limit,
        skip: page.offset,
      }),
      this.prisma.agentAsk.count({ where }),
    ]);
    return { asks, total };
  }
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

/** The chat-service calls the ask flow makes. */
export type AskChatClient = Pick<
  ChatClient,
  "createThread" | "createMessage" | "listMessages"
>;

export interface AgentAskDeps {
  config: AgentAskConfig;
  store: AgentAskStore;
  /** Injected for deterministic polling; defaults to the system clock. */
  clock?: Clock;
  /** Injected for deterministic polling; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

interface RegisterDeps {
  agentAsk?: AgentAskDeps;
  chatClient?: AskChatClient;
  agentService: Pick<AgentService, "exists">;
}

/** Poll cadence while waiting for a reply. */
export const ASK_POLL_INTERVAL_MS = 1000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Routes ───────────────────────────────────────────────────────────────────

const jsonError = {
  content: { "application/json": { schema: ErrorSchema } },
};

const askRoute = createRoute({
  method: "post",
  path: "/agents/{id}/ask",
  summary: "Ask another agent a question",
  description:
    "Posts `question` from agent `from` into a new `kind: ask` chat thread of agent `{id}` (always created with `askDepth: 1`), then, when `waitMs > 0`, polls once per second until the agent replies or the budget ends. Callers: `*`, `platform.ops`, or the agent key whose id equals `from` (never impersonation). The `from>{id}` pair must be on SHIPWRIGHT_AGENT_ASK_ALLOWLIST. Every ask writes an AgentAsk audit row (no question text). 404 unless SHIPWRIGHT_AGENT_ASK_ENABLED is `enabled`; 503 when the chat service is not configured.",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: { "application/json": { schema: AgentAskBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Ask posted; `replied` with the reply, or `pending`",
      content: { "application/json": { schema: AgentAskResponseSchema } },
    },
    400: {
      description: "Bad request (including depth other than 1)",
      ...jsonError,
    },
    403: {
      description: "Caller not allowed, or the pair is not allowlisted",
      ...jsonError,
    },
    404: {
      description: "Agent not found, or agent ask disabled",
      ...jsonError,
    },
    503: { description: "Chat service not configured", ...jsonError },
  },
});

const listAsksRoute = createRoute({
  method: "get",
  path: "/agents/{id}/asks",
  summary: "List agent asks",
  description:
    "Lists the AgentAsk audit rows the agent sent or received, newest first. `*`, `platform.read` and `platform.ops` callers only. 404 unless SHIPWRIGHT_AGENT_ASK_ENABLED is `enabled`.",
  request: { params: AgentIdParamSchema, query: ListAgentAsksQuerySchema },
  responses: {
    200: {
      description: "Audit rows",
      content: { "application/json": { schema: AgentAskListSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Agent ask disabled", ...jsonError },
  },
});

function scopeKind(c: { get: (k: "scope") => unknown }) {
  return (c.get("scope") as AdminScope | undefined)?.kind;
}

/** The reply to `userMessageId`: the first assistant message after it. */
function findReply(
  messages: ChatMessage[],
  userMessageId: string,
): { repliedAt: Date; body?: string } | null {
  const idx = messages.findIndex((m) => m.id === userMessageId);
  const user = messages[idx];
  if (!user?.repliedAt) return null;
  const reply = messages.slice(idx + 1).find((m) => m.role === "assistant");
  return {
    repliedAt: new Date(user.repliedAt),
    ...(reply ? { body: reply.body } : {}),
  };
}

function toRecord(row: AskAuditRow) {
  return {
    id: row.id,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    threadId: row.threadId,
    depth: row.depth,
    waitMs: row.waitMs,
    ttlSeconds: row.ttlSeconds,
    status: row.status,
    callerLabel: row.callerLabel,
    createdAt: row.createdAt.toISOString(),
    repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
  };
}

/**
 * Register the ask routes on the admin app. Must run after the /agents/*
 * auth middleware is mounted.
 */
export function registerAgentAskRoutes(
  app: OpenAPIHono<AdminAuthEnv>,
  deps: RegisterDeps,
): void {
  const { agentAsk, chatClient, agentService } = deps;
  const enabled = agentAsk?.config.enabled === true;

  // Flag gate ahead of body/query validation, so a disabled route is a plain
  // 404 whatever the request looks like (as accounts-api does for self-serve).
  for (const path of ["/agents/:id/ask", "/agents/:id/asks"]) {
    app.use(path, async (c, next) => {
      if (!enabled) return c.json({ error: "Not found" }, 404);
      await next();
    });
  }

  app.openapi(askRoute, async (c) => {
    if (!agentAsk) throw new NotFoundError();
    const { id: to } = c.req.valid("param");
    const body = c.req.valid("json");
    const { from, question, waitMs, ttlSeconds } = body;

    const scope = c.get("scope") as AdminScope | undefined;
    const allowedCaller =
      c.get("isAdmin") === true ||
      scope?.kind === "platform-ops" ||
      (scope?.kind === "agent" && scope.agentId === from);
    if (!allowedCaller) {
      throw new ForbiddenError(
        "Only *, platform.ops or the agent's own key (as `from`) can ask",
      );
    }
    if (!chatClient) {
      return c.json({ error: "chat service not configured" }, 503);
    }
    if (body.depth !== 1) throw new BadRequestError("depth is capped at 1");
    if (!isAskAllowed(agentAsk.config, from, to)) {
      throw new ForbiddenError("ask not allowed for this pair");
    }
    if (!(await agentService.exists(to))) {
      throw new NotFoundError(`agent ${to} not found`);
    }

    const clock = agentAsk.clock ?? SystemClock();
    const sleep = agentAsk.sleep ?? realSleep;
    const label = callerLabel(c.get("caller"), scope?.kind);
    const log = (askId: string, status: string) =>
      console.log(
        JSON.stringify({
          event: "agent-ask",
          askId,
          from,
          to,
          status,
          callerLabel: label,
        }),
      );

    const row = await agentAsk.store.create({
      fromAgentId: from,
      toAgentId: to,
      depth: 1,
      waitMs,
      ttlSeconds,
      status: "created",
      callerLabel: label,
    });

    let threadId: string | null = null;
    let userMessageId: string;
    try {
      const thread = await chatClient.createThread(to, {
        kind: "ask",
        askFromAgentId: from,
        askDepth: 1,
        title: `ask from ${from} - ${clock.now().toISOString()}`,
      });
      threadId = thread.id;
      userMessageId = (
        await chatClient.createMessage(thread.id, "user", question)
      ).id;
    } catch (err) {
      await agentAsk.store.update(row.id, { status: "failed", threadId });
      log(row.id, "failed");
      throw err;
    }

    let reply: { repliedAt: Date; body?: string } | null = null;
    const deadline = clock.now().getTime() + waitMs;
    for (;;) {
      const remaining = deadline - clock.now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(ASK_POLL_INTERVAL_MS, remaining));
      try {
        const { messages } = await chatClient.listMessages(threadId);
        reply = findReply(messages, userMessageId);
      } catch (err) {
        // The question is delivered; a failed poll only shortens the wait.
        console.warn(
          `[agent-ask] poll failed for ask ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (reply) break;
    }

    const status = reply ? "replied" : "pending";
    await agentAsk.store.update(row.id, {
      threadId,
      status,
      repliedAt: reply?.repliedAt ?? null,
    });
    log(row.id, status);
    return c.json(
      {
        askId: row.id,
        threadId,
        status,
        ...(reply?.body !== undefined ? { reply: reply.body } : {}),
      },
      201,
    );
  });

  app.openapi(listAsksRoute, async (c) => {
    if (!agentAsk) throw new NotFoundError();
    const kind = scopeKind(c);
    if (
      c.get("isAdmin") !== true &&
      kind !== "platform-read" &&
      kind !== "platform-ops"
    ) {
      throw new ForbiddenError(
        "Only *, platform.read and platform.ops callers can list asks",
      );
    }
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const { asks, total } = await agentAsk.store.listForAgent(id, {
      limit,
      offset,
    });
    return c.json({ asks: asks.map(toRecord), total, limit, offset }, 200);
  });
}
