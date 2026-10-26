/**
 * runtime/cron-run-now.unit.test.ts
 * Honour / expire / once logic for cron run-now requests (COS-42.1), with an
 * injected clock and dispatch.
 */

import { describe, expect, it } from "bun:test";
import {
  createRunNowHonourer,
  RUN_NOW_FRESH_MS,
  type RunNowJob,
} from "./cron-run-now.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function job(over: Partial<RunNowJob> = {}): RunNowJob {
  return {
    id: "job-1",
    prompt: "stored prompt",
    channel: "C1",
    user: null,
    silent: false,
    preCheck: null,
    runRequestedAt: null,
    ...over,
  };
}

function setup() {
  let nowMs = NOW.getTime();
  const dispatched: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const honour = createRunNowHonourer({
    clock: { now: () => new Date(nowMs) },
    dispatch: async (req) => {
      dispatched.push(req as unknown as Record<string, unknown>);
    },
    log: (line) => logs.push(line),
  });
  return {
    honour,
    dispatched,
    logs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("createRunNowHonourer", () => {
  it("runs a fresh request once with the stored job fields and run-now variant", async () => {
    const { honour, dispatched } = setup();
    await honour([job({ runRequestedAt: ago(60_000) })]);
    expect(dispatched).toEqual([
      {
        jobId: "job-1",
        prompt: "stored prompt",
        channel: "C1",
        user: undefined,
        silent: false,
        preCheck: undefined,
        commandVariant: "run-now",
      },
    ]);
  });

  it("does not run the same request twice across ticks", async () => {
    const { honour, dispatched, advance } = setup();
    const j = job({ runRequestedAt: ago(60_000) });
    await honour([j]);
    advance(60_000);
    await honour([j]);
    await honour([j]);
    expect(dispatched).toHaveLength(1);
  });

  it("runs again for a strictly newer request", async () => {
    const { honour, dispatched, advance } = setup();
    await honour([job({ runRequestedAt: ago(60_000) })]);
    advance(120_000);
    await honour([job({ runRequestedAt: ago(10_000) })]);
    expect(dispatched).toHaveLength(2);
  });

  it("ignores an older-or-equal stamp than the last honoured", async () => {
    const { honour, dispatched } = setup();
    await honour([job({ runRequestedAt: ago(10_000) })]);
    await honour([job({ runRequestedAt: ago(30_000) })]);
    expect(dispatched).toHaveLength(1);
  });

  it("ignores a request older than 15 minutes and logs expired once", async () => {
    const { honour, dispatched, logs } = setup();
    const j = job({ runRequestedAt: ago(RUN_NOW_FRESH_MS + 1) });
    await honour([j]);
    await honour([j]);
    expect(dispatched).toEqual([]);
    const expired = logs.filter((l) => l.includes("expired"));
    expect(expired).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("stored prompt");
  });

  it("a request exactly 15 minutes old is still fresh", async () => {
    const { honour, dispatched } = setup();
    await honour([job({ runRequestedAt: ago(RUN_NOW_FRESH_MS) })]);
    expect(dispatched).toHaveLength(1);
  });

  it("a request that ages out between ticks without being seen expires", async () => {
    const { honour, dispatched, logs, advance } = setup();
    const j = job({ runRequestedAt: ago(0) });
    advance(RUN_NOW_FRESH_MS + 60_000);
    await honour([j]);
    expect(dispatched).toEqual([]);
    expect(logs.some((l) => l.includes("expired"))).toBe(true);
  });

  it("skips jobs with no request", async () => {
    const { honour, dispatched, logs } = setup();
    await honour([job(), job({ id: "job-2" })]);
    expect(dispatched).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a failing dispatch does not stop the other jobs and is not retried", async () => {
    const dispatched: string[] = [];
    const failures: string[] = [];
    const honour = createRunNowHonourer({
      clock: { now: () => NOW },
      dispatch: async (req) => {
        dispatched.push(req.jobId);
        if (req.jobId === "bad") throw new Error("boom");
      },
      onError: (jobId) => {
        failures.push(jobId);
      },
      log: () => {},
    });
    const jobs = [
      job({ id: "bad", runRequestedAt: ago(1000) }),
      job({ id: "good", runRequestedAt: ago(1000) }),
    ];
    await honour(jobs);
    await honour(jobs);
    expect(dispatched).toEqual(["bad", "good"]);
    expect(failures).toEqual(["bad"]);
  });
});
