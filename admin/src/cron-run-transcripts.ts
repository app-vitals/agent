/**
 * admin/src/cron-run-transcripts.ts
 *
 * Redacted cron-run transcripts (COS-43.1):
 *   PUT /agents/{id}/crons/{cronId}/runs/{runId}/transcript   (agent key or admin)
 *   GET /agents/{id}/crons/{cronId}/runs/{runId}/transcript   (admin / platform only)
 *
 * The runtime redacts and tail-truncates before uploading; admin only caps the
 * size (1 MiB, 413) and stores. Gates: flag (SHIPWRIGHT_TRANSCRIPT_API_ENABLED,
 * 404 when off) -> caller. GET is closed to agent keys, even for their own
 * runs, and writes an AgentTranscriptRead audit row BEFORE responding. The
 * body is never logged. Retention: PUT keeps the newest 200 transcripts per
 * agent.
 */

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AdminAuthEnv, AdminScope } from "./api-auth.ts";
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from "./errors.ts";
import {
  CronRunIdParamSchema,
  CronRunTranscriptSchema,
  CronRunTranscriptUploadResultSchema,
  ErrorSchema,
  UploadCronRunTranscriptBodySchema,
} from "./openapi-schemas.ts";
import type { TranscriptConfig } from "./transcript-config.ts";

/** Largest accepted transcript body, in UTF-8 bytes. */
export const MAX_TRANSCRIPT_BODY_BYTES = 1024 * 1024;

/** Transcripts kept per agent; older ones are deleted on each upload. */
export const TRANSCRIPT_RETENTION_PER_AGENT = 200;

export interface TranscriptRow {
  runId: string;
  agentId: string;
  cronId: string;
  sessionId: string | null;
  bytes: number;
  truncated: boolean;
  redactions: number;
  body: string;
  createdAt: Date;
}

export interface TranscriptReadRow {
  runId: string;
  agentId: string;
  reader: string;
  scopeKind: string;
  at: Date;
}

export type TranscriptUpsertInput = Omit<TranscriptRow, "createdAt">;

export interface TranscriptStore {
  /**
   * Validates run -> cron -> agent ownership (NotFoundError otherwise), upserts
   * by runId, then sweeps the agent down to the newest 200 transcripts.
   */
  upsert(input: TranscriptUpsertInput): Promise<TranscriptRow>;
  get(
    agentId: string,
    cronId: string,
    runId: string,
  ): Promise<TranscriptRow | null>;
  recordRead(row: Omit<TranscriptReadRow, "at">): Promise<void>;
}

/** Prisma-backed transcript store. */
export class CronRunTranscriptService implements TranscriptStore {
  constructor(
    private prisma: Pick<
      PrismaClient,
      "agentCronRun" | "agentCronRunTranscript" | "agentTranscriptRead"
    >,
  ) {}

  async upsert(input: TranscriptUpsertInput): Promise<TranscriptRow> {
    // Same ownership rule as AgentCronRunService.patch.
    const run = await this.prisma.agentCronRun.findUnique({
      where: { id: input.runId },
    });
    if (!run || run.agentId !== input.agentId || run.cronId !== input.cronId) {
      throw new NotFoundError(`cron run ${input.runId} not found`);
    }
    const fields = {
      agentId: input.agentId,
      cronId: input.cronId,
      sessionId: input.sessionId,
      bytes: input.bytes,
      truncated: input.truncated,
      redactions: input.redactions,
      body: input.body,
    };
    const row = await this.prisma.agentCronRunTranscript.upsert({
      where: { runId: input.runId },
      create: { runId: input.runId, ...fields },
      update: { ...fields, createdAt: new Date() },
    });
    await this.sweep(input.agentId);
    return row;
  }

  /** Deletes every transcript of the agent beyond the newest 200. */
  private async sweep(agentId: string): Promise<void> {
    const stale = await this.prisma.agentCronRunTranscript.findMany({
      where: { agentId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: TRANSCRIPT_RETENTION_PER_AGENT,
      select: { id: true },
    });
    if (stale.length === 0) return;
    await this.prisma.agentCronRunTranscript.deleteMany({
      where: { id: { in: stale.map((r) => r.id) } },
    });
  }

  async get(
    agentId: string,
    cronId: string,
    runId: string,
  ): Promise<TranscriptRow | null> {
    const row = await this.prisma.agentCronRunTranscript.findUnique({
      where: { runId },
    });
    if (!row || row.agentId !== agentId || row.cronId !== cronId) return null;
    return row;
  }

  async recordRead(row: Omit<TranscriptReadRow, "at">): Promise<void> {
    await this.prisma.agentTranscriptRead.create({ data: row });
  }
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface CronRunTranscriptDeps {
  config: TranscriptConfig;
  store: TranscriptStore;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const jsonError = {
  content: { "application/json": { schema: ErrorSchema } },
};

const putTranscriptRoute = createRoute({
  method: "put",
  path: "/agents/{id}/crons/{cronId}/runs/{runId}/transcript",
  summary: "Upload a cron run transcript",
  description:
    "Stores (upserts) the runtime's already-redacted session transcript for a cron run, then keeps only the agent's newest 200 transcripts. Callers: the agent's own key, or `*`. `body` over 1 MiB (UTF-8 bytes) is a 413. 404 unless SHIPWRIGHT_TRANSCRIPT_API_ENABLED is `enabled`, or when the run is not owned by the cron/agent.",
  request: {
    params: CronRunIdParamSchema,
    body: {
      content: {
        "application/json": { schema: UploadCronRunTranscriptBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Transcript stored",
      content: {
        "application/json": { schema: CronRunTranscriptUploadResultSchema },
      },
    },
    400: { description: "Bad request", ...jsonError },
    403: { description: "Caller not allowed", ...jsonError },
    404: {
      description: "Run not found, or transcript API disabled",
      ...jsonError,
    },
    413: { description: "Transcript body over 1 MiB", ...jsonError },
  },
});

const getTranscriptRoute = createRoute({
  method: "get",
  path: "/agents/{id}/crons/{cronId}/runs/{runId}/transcript",
  summary: "Get a cron run transcript",
  description:
    "Returns the stored redacted transcript. `*`, `platform.read` and `platform.ops` callers only: an agent key is 403 even for its own runs. Every read writes an AgentTranscriptRead audit row before the response. 404 when SHIPWRIGHT_TRANSCRIPT_API_ENABLED is not `enabled` or no transcript exists.",
  request: { params: CronRunIdParamSchema },
  responses: {
    200: {
      description: "The transcript",
      content: { "application/json": { schema: CronRunTranscriptSchema } },
    },
    403: { description: "Forbidden", ...jsonError },
    404: {
      description: "No transcript, or transcript API disabled",
      ...jsonError,
    },
  },
});

/**
 * Register the transcript routes on the admin app. Must run after the
 * /agents/* auth middleware is mounted.
 */
export function registerCronRunTranscriptRoutes(
  app: OpenAPIHono<AdminAuthEnv>,
  deps: { transcripts?: CronRunTranscriptDeps },
): void {
  const { transcripts } = deps;
  const enabled = transcripts?.config.enabled === true;

  // Flag gate ahead of body validation: a disabled route is a plain 404.
  app.use(
    "/agents/:id/crons/:cronId/runs/:runId/transcript",
    async (c, next) => {
      if (!enabled) return c.json({ error: "Not found" }, 404);
      await next();
    },
  );

  app.openapi(putTranscriptRoute, async (c) => {
    if (!transcripts) throw new NotFoundError();
    const { id: agentId, cronId, runId } = c.req.valid("param");
    const scope = c.get("scope") as AdminScope | undefined;
    const allowed =
      c.get("isAdmin") === true ||
      (scope?.kind === "agent" && scope.agentId === agentId);
    if (!allowed) {
      throw new ForbiddenError(
        "Only * or the agent's own key can upload a transcript",
      );
    }
    const body = c.req.valid("json");
    const bytes = Buffer.byteLength(body.body, "utf8");
    if (bytes > MAX_TRANSCRIPT_BODY_BYTES) {
      throw new PayloadTooLargeError(
        `transcript body exceeds ${MAX_TRANSCRIPT_BODY_BYTES} bytes`,
      );
    }
    const row = await transcripts.store.upsert({
      runId,
      agentId,
      cronId,
      sessionId: body.sessionId ?? null,
      bytes,
      truncated: body.truncated,
      redactions: body.redactions,
      body: body.body,
    });
    // Metadata only; the body is never logged.
    console.log(
      JSON.stringify({
        event: "transcript.upload",
        agentId,
        cronId,
        runId,
        bytes,
        truncated: row.truncated,
        redactions: row.redactions,
      }),
    );
    return c.json(
      {
        runId,
        bytes: row.bytes,
        truncated: row.truncated,
        redactions: row.redactions,
      },
      200,
    );
  });

  app.openapi(getTranscriptRoute, async (c) => {
    if (!transcripts) throw new NotFoundError();
    const scope = c.get("scope") as AdminScope | undefined;
    const kind = scope?.kind;
    const allowed =
      c.get("isAdmin") === true ||
      kind === "platform-read" ||
      kind === "platform-ops";
    if (!allowed) {
      throw new ForbiddenError(
        "Only *, platform.read and platform.ops callers can read transcripts",
      );
    }
    const { id: agentId, cronId, runId } = c.req.valid("param");
    const row = await transcripts.store.get(agentId, cronId, runId);
    if (!row) throw new NotFoundError("transcript not found");
    // Audit first: if the write fails, the body is not served.
    await transcripts.store.recordRead({
      runId,
      agentId,
      reader: c.get("caller")?.name ?? "anonymous",
      scopeKind: kind ?? (c.get("isAdmin") === true ? "admin" : "session"),
    });
    return c.json(
      {
        runId: row.runId,
        cronId: row.cronId,
        sessionId: row.sessionId,
        bytes: row.bytes,
        truncated: row.truncated,
        redactions: row.redactions,
        createdAt: row.createdAt.toISOString(),
        body: row.body,
      },
      200,
    );
  });
}
