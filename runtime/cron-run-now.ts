/**
 * runtime/cron-run-now.ts
 *
 * Honours cron run-now requests (COS-42.1). The admin stamps
 * `runRequestedAt` on a stored cron job; on each cron sync tick the runtime
 * runs the job once when the stamp is strictly newer than the last one it
 * honoured (held in memory) and at most 15 minutes old. An older stamp is
 * logged as expired and never run. The request is dispatched with the job's
 * own stored fields, never a prompt from anywhere else, and tagged
 * commandVariant "run-now" so run creation clears the stamp admin-side.
 */

import type { Clock } from "./clock.ts";

/** A request older than this is expired and never run. */
export const RUN_NOW_FRESH_MS = 15 * 60_000;

/** The stored cron job fields the honourer reads. */
export interface RunNowJob {
  id: string;
  prompt: string;
  channel?: string | null;
  user?: string | null;
  silent?: boolean;
  preCheck?: string | null;
  /** A manually disabled job is never run, even with a fresh stamp. */
  enabled?: boolean;
  /** ISO string on the wire (typed Date by the generated client). */
  runRequestedAt?: string | Date | null;
}

export interface RunNowRequest {
  jobId: string;
  prompt: string;
  channel?: string;
  user?: string;
  silent?: boolean;
  preCheck?: string;
  commandVariant: "run-now";
}

interface RunNowHonourerDeps {
  clock: Clock;
  /** Runs the job (handleCronRequest in production). */
  dispatch: (req: RunNowRequest) => Promise<void>;
  /** Called when a dispatch throws; the request is not retried. */
  onError?: (jobId: string, err: unknown) => void | Promise<void>;
  log?: (line: string) => void;
}

/**
 * Returns a function to call with the fresh job list on every sync tick. It
 * resolves once every dispatch it started has settled; callers that must not
 * wait on long runs simply do not await it.
 */
export function createRunNowHonourer(
  deps: RunNowHonourerDeps,
): (jobs: readonly RunNowJob[]) => Promise<void> {
  const { clock, dispatch, onError, log = console.log } = deps;
  // jobId -> last honoured / last expired-logged runRequestedAt (epoch ms).
  const lastHonoured = new Map<string, number>();
  const expiredLogged = new Map<string, number>();

  return async (jobs) => {
    const running: Promise<void>[] = [];
    for (const job of jobs) {
      if (!job.runRequestedAt || job.enabled === false) continue;
      const requestedMs = new Date(job.runRequestedAt).getTime();
      if (Number.isNaN(requestedMs)) continue;
      const requested = new Date(requestedMs).toISOString();

      const seen = lastHonoured.get(job.id);
      if (seen !== undefined && requestedMs <= seen) continue;

      if (clock.now().getTime() - requestedMs > RUN_NOW_FRESH_MS) {
        if (expiredLogged.get(job.id) !== requestedMs) {
          expiredLogged.set(job.id, requestedMs);
          log(
            JSON.stringify({
              event: "cron-run-now",
              status: "expired",
              jobId: job.id,
              requestedAt: requested,
            }),
          );
        }
        continue;
      }

      // Recorded before dispatch so a slow or failing run is never repeated.
      lastHonoured.set(job.id, requestedMs);
      log(
        JSON.stringify({
          event: "cron-run-now",
          status: "honouring",
          jobId: job.id,
          requestedAt: requested,
        }),
      );
      running.push(
        dispatch({
          jobId: job.id,
          prompt: job.prompt,
          channel: job.channel ?? undefined,
          user: job.user ?? undefined,
          silent: job.silent,
          preCheck: job.preCheck ?? undefined,
          commandVariant: "run-now",
        }).catch(async (err) => {
          await onError?.(job.id, err);
        }),
      );
    }
    await Promise.all(running);
  };
}
