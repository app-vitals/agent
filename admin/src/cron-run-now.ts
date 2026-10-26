/**
 * admin/src/cron-run-now.ts
 *
 * Cron run-now (COS-42.1): POST /agents/{id}/crons/{cronId}/run-now asks the
 * agent's runtime to fire one cron job immediately. The route takes NO body
 * and never reads or logs a prompt: it only stamps `runRequestedAt` /
 * `runRequestedBy` on the stored job and writes an AgentCronRunRequest audit
 * row (before the 202). The runtime's cron sync honours the stamp once, while
 * it is fresh, running the job's own stored prompt.
 *
 * Gates, in order: flag (SHIPWRIGHT_CRON_RUN_NOW_ENABLED, 404 when off) →
 * caller (`*`, platform.ops, or the agent's own key; 403) → empty body (400)
 * → cron exists for the agent (404) → not lockdown-disabled (409).
 */

import { callerLabel } from "@app-vitals/agent-lib/request-context";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AdminAuthEnv, AdminScope } from "./api-auth.ts";
import { type Clock, SystemClock } from "./clock.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.ts";
import type { CronRunNowConfig } from "./cron-run-now-config.ts";
import {
  CronIdParamSchema,
  CronRunNowResponseSchema,
  ErrorSchema,
} from "./openapi-schemas.ts";

// ─── Store ────────────────────────────────────────────────────────────────────

/** The cron fields the route needs. Never the prompt. */
export interface RunNowCron {
  id: string;
  agentId: string;
  lockdownDisabledAt: Date | null;
}

/** One AgentCronRunRequest audit row. No prompt text, by design. */
export interface RunRequestRow {
  id: string;
  cronId: string;
  agentId: string;
  requestedBy: string;
  requestedAt: Date;
  status: string;
  honouredRunId: string | null;
}

export interface CronRunNowStore {
  findCron(agentId: string, cronId: string): Promise<RunNowCron | null>;
  /** Stamp the job and write the audit row, atomically. */
  recordRequest(input: {
    cronId: string;
    agentId: string;
    requestedBy: string;
    requestedAt: Date;
  }): Promise<RunRequestRow>;
}

/** Prisma-backed run-now store. */
export class CronRunNowService implements CronRunNowStore {
  constructor(
    private prisma: Pick<
      PrismaClient,
      "agentCronJob" | "agentCronRunRequest" | "$transaction"
    >,
  ) {}

  findCron(agentId: string, cronId: string): Promise<RunNowCron | null> {
    return this.prisma.agentCronJob.findFirst({
      where: { id: cronId, agentId },
      select: { id: true, agentId: true, lockdownDisabledAt: true },
    });
  }

  recordRequest(input: {
    cronId: string;
    agentId: string;
    requestedBy: string;
    requestedAt: Date;
  }): Promise<RunRequestRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.agentCronJob.update({
        where: { id: input.cronId },
        data: {
          runRequestedAt: input.requestedAt,
          runRequestedBy: input.requestedBy,
        },
      });
      return tx.agentCronRunRequest.create({
        data: { ...input, status: "requested" },
      });
    });
  }
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface CronRunNowDeps {
  config: CronRunNowConfig;
  store: CronRunNowStore;
  /** Injected for deterministic timestamps; defaults to the system clock. */
  clock?: Clock;
}

// ─── Route ────────────────────────────────────────────────────────────────────

const jsonError = {
  content: { "application/json": { schema: ErrorSchema } },
};

const runNowRoute = createRoute({
  method: "post",
  path: "/agents/{id}/crons/{cronId}/run-now",
  summary: "Request an immediate run of a cron job",
  description:
    "Asks the agent's runtime to run the cron job once, now, with the job's own stored prompt. Takes no request body (any body is 400). Stamps `runRequestedAt` on the job and writes an AgentCronRunRequest audit row before returning 202; the runtime honours a fresh request (under 15 minutes old) once on its next cron sync. Callers: `*`, `platform.ops`, or the agent's own key. 404 unless SHIPWRIGHT_CRON_RUN_NOW_ENABLED is `enabled`; 409 when the trial-expiry lockdown disabled the cron.",
  request: { params: CronIdParamSchema },
  responses: {
    202: {
      description: "Run requested",
      content: { "application/json": { schema: CronRunNowResponseSchema } },
    },
    400: { description: "A request body was sent", ...jsonError },
    403: { description: "Caller not allowed", ...jsonError },
    404: {
      description: "Cron not found, or cron run-now disabled",
      ...jsonError,
    },
    409: { description: "Cron disabled by lockdown", ...jsonError },
  },
});

/**
 * Register the run-now route on the admin app. Must run after the /agents/*
 * auth middleware is mounted.
 */
export function registerCronRunNowRoutes(
  app: OpenAPIHono<AdminAuthEnv>,
  deps: { cronRunNow?: CronRunNowDeps },
): void {
  const { cronRunNow } = deps;
  const enabled = cronRunNow?.config.enabled === true;

  // Flag gate ahead of everything else, so a disabled route is a plain 404.
  app.use("/agents/:id/crons/:cronId/run-now", async (c, next) => {
    if (!enabled) return c.json({ error: "Not found" }, 404);
    await next();
  });

  app.openapi(runNowRoute, async (c) => {
    if (!cronRunNow) throw new NotFoundError();
    const { id: agentId, cronId } = c.req.valid("param");

    const scope = c.get("scope") as AdminScope | undefined;
    const allowedCaller =
      c.get("isAdmin") === true ||
      scope?.kind === "platform-ops" ||
      (scope?.kind === "agent" && scope.agentId === agentId);
    if (!allowedCaller) {
      throw new ForbiddenError(
        "Only *, platform.ops or the agent's own key can request a run",
      );
    }

    // The prompt is never taken from the request: reject any body.
    if ((await c.req.text()).length > 0) {
      throw new BadRequestError("run-now takes no request body");
    }

    const cron = await cronRunNow.store.findCron(agentId, cronId);
    if (!cron) throw new NotFoundError(`cron job ${cronId} not found`);
    if (cron.lockdownDisabledAt) {
      throw new ConflictError("cron job is disabled by lockdown");
    }

    const requestedAt = (cronRunNow.clock ?? SystemClock()).now();
    const requestedBy = callerLabel(c.get("caller"), scope?.kind);
    await cronRunNow.store.recordRequest({
      cronId,
      agentId,
      requestedBy,
      requestedAt,
    });
    console.log(
      JSON.stringify({
        event: "cron-run-now",
        agentId,
        cronId,
        requestedAt: requestedAt.toISOString(),
        callerLabel: requestedBy,
      }),
    );
    return c.json({ requestedAt: requestedAt.toISOString() }, 202);
  });
}
