/**
 * admin/src/cron-run-now-config.unit.test.ts
 * Pure parser tests for the cron run-now flag (COS-42.1).
 */

import { describe, expect, it } from "bun:test";
import { parseCronRunNowConfig } from "./cron-run-now-config.ts";

describe("parseCronRunNowConfig", () => {
  it('is on only for the literal "enabled"', () => {
    expect(
      parseCronRunNowConfig({ SHIPWRIGHT_CRON_RUN_NOW_ENABLED: "enabled" })
        .enabled,
    ).toBe(true);
  });

  it('"true", "" and absent are off', () => {
    for (const value of ["true", "", "Enabled", " enabled", undefined]) {
      expect(
        parseCronRunNowConfig({ SHIPWRIGHT_CRON_RUN_NOW_ENABLED: value })
          .enabled,
      ).toBe(false);
    }
    expect(parseCronRunNowConfig({}).enabled).toBe(false);
  });
});
