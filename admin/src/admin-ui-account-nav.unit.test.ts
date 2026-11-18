/**
 * admin/src/admin-ui-account-nav.unit.test.ts
 * Audience plumbing for the admin toolbar.
 */

import { describe, expect, test } from "bun:test";
import {
  currentToolbarViewer,
  runWithToolbarAudience,
} from "./admin-ui-account-nav.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";

describe("toolbar audience context", () => {
  test("no viewer outside any context", () => {
    expect(currentToolbarViewer()).toBeUndefined();
  });
  test("nested contexts override", () => {
    runWithToolbarAudience("admin", () => {
      expect(currentToolbarViewer()).toEqual({ audience: "admin" });
      runWithToolbarAudience("member", () => {
        expect(currentToolbarViewer()?.audience).toBe("member");
      });
    });
  });
});

describe("renderAdminToolbar audience mapping", () => {
  const settings = 'href="/admin/settings"';
  test("outside a context: renders the member audience", () => {
    const html = renderAdminToolbar("a@x.com");
    expect(html).toContain("Agents");
    expect(html).toBe(
      runWithToolbarAudience("member", () => renderAdminToolbar("a@x.com")),
    );
  });
  test("admin sees Settings", () => {
    expect(
      runWithToolbarAudience("admin", () => renderAdminToolbar("a@x.com")),
    ).toContain(settings);
  });
  test("member does not see Settings but sees the other items", () => {
    const html = runWithToolbarAudience("member", () =>
      renderAdminToolbar("a@x.com"),
    );
    expect(html).not.toContain(settings);
    expect(html).toContain("/admin/sessions");
  });
  test("admin sees Queue & Activity", () => {
    const base = runWithToolbarAudience("admin", () => renderAdminToolbar("a"));
    expect(base).toContain("Queue &amp; Activity");
  });
});
