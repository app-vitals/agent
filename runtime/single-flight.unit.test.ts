/**
 * runtime/single-flight.unit.test.ts
 *
 * Unit tests for singleFlight() — the re-entry guard on boot.ts's syncConfig()
 * interval. Pure logic with an injected clock and hand-resolved promises; no
 * timers, no I/O.
 */

import { describe, expect, test } from "bun:test";
import { singleFlight } from "./single-flight.ts";

/** A promise whose settlement the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  test("runs the function when nothing is in flight", async () => {
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs++;
    });

    await guarded();
    await guarded();

    expect(runs).toBe(2);
  });

  test("drops a call made while the previous run is still in flight", async () => {
    const gate = deferred();
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs++;
      await gate.promise;
    });

    const first = guarded();
    await guarded();
    await guarded();
    expect(runs).toBe(1);

    gate.resolve();
    await first;
    await guarded();
    expect(runs).toBe(2);
  });

  test("reports how long the in-flight run has been going on each skip", async () => {
    const gate = deferred();
    let clock = 1_000;
    const skips: number[] = [];
    const guarded = singleFlight(() => gate.promise, {
      now: () => clock,
      onSkip: (ms) => skips.push(ms),
    });

    const first = guarded();
    clock = 61_000;
    await guarded();
    clock = 121_000;
    await guarded();

    expect(skips).toEqual([60_000, 120_000]);

    gate.resolve();
    await first;
  });

  test("does not call onSkip when no run is in flight", async () => {
    const skips: number[] = [];
    const guarded = singleFlight(async () => {}, {
      onSkip: (ms) => skips.push(ms),
    });

    await guarded();
    await guarded();

    expect(skips).toEqual([]);
  });

  test("releases the guard and passes the rejection through when a run fails", async () => {
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs++;
      if (runs === 1) throw new Error("boom");
    });

    await expect(guarded()).rejects.toThrow("boom");
    await guarded();

    expect(runs).toBe(2);
  });
});
