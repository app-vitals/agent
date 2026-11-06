/**
 * runtime/cron-sync.ts
 * Reconciles scheduled cron tasks against the desired job list on each sync
 * tick. A job whose schedule, prompt, channel, user, silent, preCheck or
 * dispatch kind changed is stopped and rescheduled; unchanged jobs are left
 * alone. The scheduler is injected so the logic is testable without node-cron.
 */

import type {
  CronDispatchKind,
  ExtensionCronJob,
  ScheduledCronJob,
} from "./agent-extension.ts";

export interface SyncableCronJob extends ExtensionCronJob {
  schedule: string;
  prompt: string;
  channel: string | null;
  user: string | null;
  silent: boolean;
  preCheck: string | null;
}

export interface StoppableTask {
  stop(): void;
}

export interface ScheduledEntry<TTask extends StoppableTask> {
  task: TTask;
  signature: string;
}

/** Everything that, when edited, must take effect on the next sync tick. */
export function cronSignature(
  job: SyncableCronJob,
  dispatch: CronDispatchKind,
): string {
  return JSON.stringify([
    job.schedule,
    job.prompt,
    job.channel,
    job.user,
    job.silent,
    job.preCheck,
    dispatch,
  ]);
}

export function reconcileCronTasks<
  TJob extends SyncableCronJob,
  TTask extends StoppableTask,
>(
  scheduled: Map<string, ScheduledEntry<TTask>>,
  desired: ScheduledCronJob<TJob>[],
  schedule: (job: TJob, dispatch: CronDispatchKind) => TTask,
  log: (message: string) => void = console.log,
): void {
  const desiredIds = new Set(desired.map((entry) => entry.job.id));

  for (const [id, existing] of scheduled) {
    if (!desiredIds.has(id)) {
      existing.task.stop();
      scheduled.delete(id);
      log(`[cron-sync] unscheduled ${id}`);
    }
  }

  for (const { job, dispatch } of desired) {
    const signature = cronSignature(job, dispatch);
    const existing = scheduled.get(job.id);
    if (existing?.signature === signature) continue;

    existing?.task.stop();
    scheduled.set(job.id, { task: schedule(job, dispatch), signature });
    log(
      existing
        ? `[cron-sync] rescheduled ${job.id} (${job.schedule})`
        : `[cron-sync] scheduled ${job.id} (${job.schedule})`,
    );
  }
}
