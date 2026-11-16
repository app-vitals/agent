/**
 * admin/src/admin-ui-settings-layout.unit.test.ts
 * Pure string assertions for renderSettingsLayout (SGL-1.1).
 */

import { describe, expect, test } from "bun:test";
import {
  buildSettingsNav,
  firstVisibleSettingsItem,
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
    expect(html).toContain('class="vos-page vos-page-wide vos-page-settings"');
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

describe("buildSettingsNav / firstVisibleSettingsItem (SGL-2.2)", () => {
  const both = { githubEnterprise: true, templates: true };
  test("Platform section lists GHE (adminOnly) then Templates", () => {
    expect(buildSettingsNav(both)).toEqual({
      sections: [
        {
          label: "Platform",
          items: [
            {
              label: "GitHub Enterprise",
              path: "/admin/settings/github-enterprise",
              adminOnly: true,
            },
            { label: "Templates", path: "/admin/settings/templates" },
          ],
        },
      ],
    });
  });
  test("omits unregistered features and empty sections", () => {
    expect(buildSettingsNav({})).toEqual({ sections: [] });
    expect(
      buildSettingsNav({ templates: true }).sections[0]?.items.map(
        (i) => i.label,
      ),
    ).toEqual(["Templates"]);
  });
  test("merges extension items into Platform or new sections", () => {
    const nav = buildSettingsNav({
      ...both,
      extraItems: [
        { section: "Platform", label: "A", path: "/a" },
        { section: "Extras", label: "B", path: "/b" },
      ],
    });
    expect(nav.sections.map((s) => s.label)).toEqual(["Platform", "Extras"]);
    expect(nav.sections[0]?.items.map((i) => i.label)).toEqual([
      "GitHub Enterprise",
      "Templates",
      "A",
    ]);
  });
  test("first visible item respects adminOnly", () => {
    const nav = buildSettingsNav(both);
    expect(firstVisibleSettingsItem(nav, true)?.label).toBe(
      "GitHub Enterprise",
    );
    expect(firstVisibleSettingsItem(nav, false)?.label).toBe("Templates");
    expect(
      firstVisibleSettingsItem(
        buildSettingsNav({ githubEnterprise: true }),
        false,
      ),
    ).toBeUndefined();
  });
});
