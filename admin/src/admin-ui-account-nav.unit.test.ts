/**
 * admin/src/admin-ui-account-nav.unit.test.ts
 * Flag plumbing for the toolbar Settings entry.
 */

import { describe, expect, test } from "bun:test";
import {
  runWithSettingsNav,
  shouldShowSettingsNav,
} from "./admin-ui-account-nav.ts";

describe("settings-nav flag", () => {
  test("hidden outside any context", () => {
    expect(shouldShowSettingsNav()).toBe(false);
  });
  test("reflects the wrapper value, including nested", () => {
    runWithSettingsNav(true, () => {
      expect(shouldShowSettingsNav()).toBe(true);
      runWithSettingsNav(false, () => {
        expect(shouldShowSettingsNav()).toBe(false);
      });
    });
  });
});
