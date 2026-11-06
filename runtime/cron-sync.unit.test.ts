/**
 * runtime/cron-sync.unit.test.ts
 * Reconcile logic for the 60s cron sync tick, with a fake scheduler.
 */

import { describe, expect, it } from "bun:test";
import type { CronDispatchKind } from "./agent-extension.ts";
import {
  reconcileCronTasks,
  type ScheduledEntry,
  type SyncableCronJob,
} from "./cron-sync.ts";

function job(over: Partial<SyncableCronJob> = {}): SyncableCronJob {
  return {
    id: "job-1",
    name: "Job",
    enabled: true,
    parentCronId: null,
    schedule: "0 * * * *",
    prompt: "do it",
    channel: "C1",
    user: "U1",
    silent: false,
    preCheck: null,
    ...over,
  };
}

function harness() {
  const created: { id: string; schedule: string; stopped: boolean }[] = [];
  const logs: string[] = [];
  const scheduled = new Map<string, ScheduledEntry<{ stop(): void }>>();
  const schedule = (j: SyncableCronJob) => {
    const rec = { id: j.id, schedule: j.schedule, stopped: false };
    created.push(rec);
    return {
      stop() {
        rec.stopped = true;
      },
    };
  };
  const tick = (
    jobs: SyncableCronJob[],
    dispatch: CronDispatchKind = "generic",
  ) =>
    reconcileCronTasks(
      scheduled,
      jobs.map((j) => ({ job: j, dispatch })),
      schedule,
      (m) => logs.push(m),
    );
  return { created, logs, scheduled, tick };
}

describe("reconcileCronTasks", () => {
  it("schedules a new job", () => {
    const h = harness();
    h.tick([job()]);
    expect(h.created).toHaveLength(1);
    expect(h.logs).toEqual(["[cron-sync] scheduled job-1 (0 * * * *)"]);
  });

  it("does not reschedule an unchanged job", () => {
    const h = harness();
    h.tick([job()]);
    h.tick([job()]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.stopped).toBe(false);
  });

  it("reschedules when the schedule changes", () => {
    const h = harness();
    h.tick([job()]);
    h.tick([job({ schedule: "*/5 * * * *" })]);
    expect(h.created).toHaveLength(2);
    expect(h.created[0]?.stopped).toBe(true);
    expect(h.created[1]?.schedule).toBe("*/5 * * * *");
    expect(h.logs.at(-1)).toContain("[cron-sync] rescheduled job-1");
  });

  it("reschedules on a prompt-only change", () => {
    const h = harness();
    h.tick([job()]);
    h.tick([job({ prompt: "new prompt" })]);
    expect(h.created).toHaveLength(2);
    expect(h.created[0]?.stopped).toBe(true);
    expect(h.created[1]?.stopped).toBe(false);
  });

  it("reschedules when channel, user, silent or preCheck change", () => {
    const h = harness();
    h.tick([job()]);
    h.tick([job({ channel: "C2" })]);
    h.tick([job({ channel: "C2", user: "U2" })]);
    h.tick([job({ channel: "C2", user: "U2", silent: true })]);
    h.tick([job({ channel: "C2", user: "U2", silent: true, preCheck: "x" })]);
    expect(h.created).toHaveLength(5);
  });

  it("reschedules when the dispatch kind changes", () => {
    const h = harness();
    h.tick([job()], "generic");
    h.tick([job()], "loop");
    expect(h.created).toHaveLength(2);
    expect(h.created[0]?.stopped).toBe(true);
  });

  it("unschedules a disabled job (absent from desired)", () => {
    const h = harness();
    h.tick([job()]);
    h.tick([]);
    expect(h.created[0]?.stopped).toBe(true);
    expect(h.scheduled.size).toBe(0);
    expect(h.logs.at(-1)).toBe("[cron-sync] unscheduled job-1");
  });

  it("unschedules a deleted job without touching its siblings", () => {
    const h = harness();
    h.tick([job(), job({ id: "job-2" })]);
    h.tick([job({ id: "job-2" })]);
    expect(h.created.find((c) => c.id === "job-1")?.stopped).toBe(true);
    expect(h.created.find((c) => c.id === "job-2")?.stopped).toBe(false);
    expect([...h.scheduled.keys()]).toEqual(["job-2"]);
  });
});
