/**
 * admin/src/pod-service-account-config.unit.test.ts
 * Pure parser tests for the per-agent pod ServiceAccount flag (COS-48.1).
 */

import { describe, expect, it } from "bun:test";
import { parsePodServiceAccountConfig } from "./pod-service-account-config.ts";

describe("parsePodServiceAccountConfig", () => {
  it('is on only for the literal "enabled"', () => {
    expect(
      parsePodServiceAccountConfig({
        SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED: "enabled",
      }).enabled,
    ).toBe(true);
  });

  it('"true", "1", "Enabled", padded, empty and absent are off', () => {
    for (const value of ["true", "1", "Enabled", " enabled", "", undefined]) {
      expect(
        parsePodServiceAccountConfig({
          SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED: value,
        }).enabled,
      ).toBe(false);
    }
    expect(parsePodServiceAccountConfig({}).enabled).toBe(false);
  });
});
