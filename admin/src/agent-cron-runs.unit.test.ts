/**
 * Unit tests for agent-cron-runs.ts's pure outcome-filter mapping
 * (buildOutcomeWhere): no DB, just the where-clause shape.
 */
import { describe, expect, test } from "bun:test";
import { buildOutcomeWhere } from "./agent-cron-runs.ts";

describe("buildOutcomeWhere", () => {
  test("no options yields no filter", () => {
    expect(buildOutcomeWhere()).toEqual({});
    expect(buildOutcomeWhere({})).toEqual({});
  });

  test("legacy outcome: skipped matches the boolean flag only", () => {
    expect(buildOutcomeWhere({ outcome: "skipped" })).toEqual({
      skipped: true,
    });
  });

  test("legacy outcome: other value requires skipped=false and equality", () => {
    expect(buildOutcomeWhere({ outcome: "success" })).toEqual({
      skipped: false,
      outcome: "success",
    });
  });

  test("outcomes: each value maps to its clause", () => {
    expect(buildOutcomeWhere({ outcomes: ["skipped"] })).toEqual({
      OR: [{ skipped: true }],
    });
    expect(buildOutcomeWhere({ outcomes: ["unknown"] })).toEqual({
      OR: [{ skipped: false, outcome: null }],
    });
    expect(buildOutcomeWhere({ outcomes: ["failed"] })).toEqual({
      OR: [{ skipped: false, outcome: "failed" }],
    });
  });

  test("outcomes: multiple values are OR'd in order", () => {
    expect(
      buildOutcomeWhere({ outcomes: ["skipped", "unknown", "completed"] }),
    ).toEqual({
      OR: [
        { skipped: true },
        { skipped: false, outcome: null },
        { skipped: false, outcome: "completed" },
      ],
    });
  });

  test("outcomes: empty array is no filter", () => {
    expect(buildOutcomeWhere({ outcomes: [] })).toEqual({});
  });

  test("outcomes wins over outcome when both are passed", () => {
    expect(
      buildOutcomeWhere({ outcome: "success", outcomes: ["failed"] }),
    ).toEqual({ OR: [{ skipped: false, outcome: "failed" }] });
  });

  test("empty outcomes still wins over outcome (no filter)", () => {
    expect(buildOutcomeWhere({ outcome: "success", outcomes: [] })).toEqual({});
  });
});
