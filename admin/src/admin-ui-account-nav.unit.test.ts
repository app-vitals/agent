/**
 * admin/src/admin-ui-account-nav.unit.test.ts
 * Flag plumbing for the toolbar Account / Settings entries.
 */

import { describe, expect, test } from "bun:test";
import {
  runWithAccountNav,
  runWithSettingsNav,
  shouldShowAccountNav,
  shouldShowSettingsNav,
} from "./admin-ui-account-nav.ts";

describe("account-nav flags", () => {
  test("both hidden outside any context", () => {
    expect(shouldShowAccountNav()).toBe(false);
    expect(shouldShowSettingsNav()).toBe(false);
  });
  test("settings flag survives a nested account wrapper, and vice versa", () => {
    runWithSettingsNav(true, () => {
      runWithAccountNav(false, () => {
        expect(shouldShowSettingsNav()).toBe(true);
        expect(shouldShowAccountNav()).toBe(false);
      });
    });
    runWithAccountNav(true, () => {
      runWithSettingsNav(false, () => {
        expect(shouldShowAccountNav()).toBe(true);
        expect(shouldShowSettingsNav()).toBe(false);
      });
    });
  });
});
