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
  test("admin audience implies Settings; nested contexts override", () => {
    runWithToolbarAudience("admin", () => {
      expect(currentToolbarViewer()).toEqual({
        audience: "admin",
        showSettings: true,
      });
      runWithToolbarAudience("member", () => {
        expect(currentToolbarViewer()?.audience).toBe("member");
        expect(currentToolbarViewer()?.showSettings).toBe(false);
      });
    });
  });
  test("member keeps Settings only with the account opt-in", () => {
    runWithToolbarAudience("member", () => {
      expect(currentToolbarViewer()?.showSettings).toBe(true);
    }, { showSettings: true });
  });
});

describe("renderAdminToolbar audience mapping", () => {
  const settings = 'href="/admin/settings"';
  test("outside a context: legacy output, no Settings", () => {
    const html = renderAdminToolbar("a@x.com");
    expect(html).not.toContain(settings);
    expect(html).toContain("Agents");
  });
  test("admin sees Settings", () => {
    expect(
      runWithToolbarAudience("admin", () => renderAdminToolbar("a@x.com")),
    ).toContain(settings);
  });
  test("plain member does not see Settings but sees the other items", () => {
    const html = runWithToolbarAudience("member", () =>
      renderAdminToolbar("a@x.com"),
    );
    expect(html).not.toContain(settings);
    expect(html).toContain("/admin/sessions");
  });
  test("account member keeps Settings (SGL-2.2)", () => {
    const html = runWithToolbarAudience(
      "member",
      () => renderAdminToolbar("a@x.com"),
      { showSettings: true },
    );
    expect(html).toContain(settings);
  });
  test("audience output matches legacy flag output", () => {
    const base = runWithToolbarAudience("admin", () => renderAdminToolbar("a"));
    expect(base).toContain("Queue &amp; Activity");
  });
});
