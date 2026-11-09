/**
 * admin/src/admin-spec.unit.test.ts
 *
 * Guards the generated platform OpenAPI spec against strings that Shipwright's
 * check-banned-strings rejects (it fails the Platform Release Bump). Example
 * values must use neutral names, e.g. "example-marketplace".
 */

import { describe, expect, it } from "bun:test";
import { buildPlatformAdminSpec } from "./admin-spec.ts";

const BANNED_PATTERNS = [/vitals-os/i];

describe("buildPlatformAdminSpec", () => {
  it("contains none of Shipwright's banned patterns", () => {
    const spec = JSON.stringify(buildPlatformAdminSpec());
    for (const pattern of BANNED_PATTERNS) {
      expect(spec).not.toMatch(pattern);
    }
  });
});
