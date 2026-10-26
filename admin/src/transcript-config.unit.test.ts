/**
 * admin/src/transcript-config.unit.test.ts
 * Pure flag parser for the cron-run transcript API (COS-43.1).
 */

import { describe, expect, it } from "bun:test";
import { parseTranscriptConfig } from "./transcript-config.ts";

describe("parseTranscriptConfig", () => {
  it('is on only for the literal "enabled"', () => {
    expect(
      parseTranscriptConfig({ SHIPWRIGHT_TRANSCRIPT_API_ENABLED: "enabled" })
        .enabled,
    ).toBe(true);
  });

  it("every other value is off", () => {
    for (const v of [
      "true",
      "",
      "Enabled",
      " enabled",
      "disabled",
      undefined,
    ]) {
      expect(
        parseTranscriptConfig({ SHIPWRIGHT_TRANSCRIPT_API_ENABLED: v }).enabled,
      ).toBe(false);
    }
    expect(parseTranscriptConfig({}).enabled).toBe(false);
  });
});
