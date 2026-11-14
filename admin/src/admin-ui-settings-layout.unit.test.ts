/**
 * admin/src/admin-ui-settings-layout.unit.test.ts
 * Pure string assertions for renderSettingsLayout (SGL-1.1).
 */

import { describe, expect, test } from "bun:test";
import {
  renderSettingsLayout,
  type SettingsNav,
} from "./admin-ui-settings-layout.ts";

const nav: SettingsNav = {
  sections: [
    {
      label: "Account",
      items: [
        { label: "Profile", path: "/admin/settings/profile" },
        { label: "Tokens", path: "/admin/settings/tokens" },
      ],
    },
    {
      label: "Admin",
      items: [
        { label: "Users", path: "/admin/settings/users", adminOnly: true },
      ],
    },
  ],
};

const render = (over: Record<string, unknown> = {}) =>
  renderSettingsLayout({
    userName: "dan",
    title: "Profile",
    nav,
    active: "/admin/settings/profile",
    body: "<p>BODY</p>",
    ...over,
  });

describe("renderSettingsLayout", () => {
  test("marks the active item with aria-current and only that item", () => {
    const html = render();
    const matches = html.match(/aria-current="page"/g) ?? [];
    // one in desktop nav, one in mobile details
    expect(matches.length).toBe(2);
    expect(html).toMatch(
      /<a [^>]*href="\/admin\/settings\/profile"[^>]*aria-current="page"/,
    );
    expect(html).not.toMatch(
      /href="\/admin\/settings\/tokens"[^>]*aria-current/,
    );
  });

  test("renders section labels, title H1, body and toolbar", () => {
    const html = render();
    expect(html).toContain("Account");
    expect(html).toContain("<h1");
    expect(html).toContain("Profile</h1>");
    expect(html).toContain("<p>BODY</p>");
    expect(html).toContain('class="vos-page');
    expect(html).toContain("vos-toolbar");
  });

  test("filters adminOnly items and drops empty sections unless isAdmin", () => {
    const html = render();
    expect(html).not.toContain("Users");
    expect(html).not.toContain(">Admin<");
    const admin = render({ isAdmin: true });
    expect(admin).toContain("Users");
    expect(admin).toContain(">Admin<");
  });

  test("escapes title, labels, paths and active", () => {
    const evil: SettingsNav = {
      sections: [
        {
          label: "<s>sec</s>",
          items: [{ label: "<b>x</b>", path: '/a"onclick="y' }],
        },
      ],
    };
    const html = render({
      title: "<script>t</script>",
      nav: evil,
      active: '/a"onclick="y',
    });
    expect(html).not.toContain("<script>t");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<s>sec");
    expect(html).not.toContain('"onclick="y');
    expect(html).toContain("&lt;script&gt;t&lt;/script&gt;");
  });

  test("renders desktop nav and mobile details with active label summary", () => {
    const html = render();
    expect(html).toContain('<nav class="settings-sidebar"');
    expect(html).toContain('<details class="settings-nav-mobile"');
    expect(html).toMatch(/<summary[^>]*>Profile<\/summary>/);
    expect(html.match(/href="\/admin\/settings\/tokens"/g)?.length).toBe(2);
  });

  test("toolbarPath defaults to active", () => {
    const withPath = render({ toolbarPath: "/admin/settings" });
    expect(withPath).toContain("vos-toolbar");
  });
});
