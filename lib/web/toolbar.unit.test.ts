/**
 * lib/web/toolbar.unit.test.ts
 * Pure unit tests for renderShipwrightToolbar().
 *
 * Strategy: call the render function directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import { renderShipwrightToolbar, TOOLBAR_NAV_ITEMS } from "./toolbar.ts";

describe("renderShipwrightToolbar", () => {
  describe("authenticated mode (readOnly=false)", () => {
    const html = renderShipwrightToolbar({
      userName: "Alice",
      activePath: "/admin/agents",
      logoutAction: "/auth/logout",
    });

    test("contains hamburger button with class vos-hamburger", () => {
      expect(html).toContain("vos-hamburger");
    });

    test("hamburger button shows ☰ icon", () => {
      expect(html).toContain("☰");
    });

    test("contains nav links for authenticated mode", () => {
      expect(html).toContain("Agents");
      expect(html).toContain("Metrics");
    });

    // TBF-1.1: the navbar Tasks link must not hardcode a state filter — doing
    // so silently pre-filtered every navbar-driven visit to ready-only tasks
    // and (post-AXR-1.3) bounced the user off the default board view. The
    // link must land on bare /admin/tasks.
    test("Tasks link has no hardcoded ?state=ready filter", () => {
      expect(html).not.toContain("/admin/tasks?state=ready");
      expect(html).toContain('href="/admin/tasks" class="vos-nav-link');
    });

    test("does not render an /admin/provision link (removed dead nav shortcut)", () => {
      expect(html).not.toContain('href="/admin/provision"');
    });

    test("active link has active class", () => {
      expect(html).toContain('class="vos-nav-link active"');
    });

    test("checkbox input appears before nav element in DOM", () => {
      expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<nav"));
    });

    test("hamburger label has aria-expanded attribute for screen reader feedback", () => {
      expect(html).toContain('aria-expanded="false"');
    });

    test("hamburger label has aria-controls pointing to nav content", () => {
      expect(html).toContain('aria-controls="vos-nav-content"');
    });

    test("nav content div has id for aria-controls target", () => {
      expect(html).toContain('id="vos-nav-content"');
    });

    test("includes JS shim to toggle aria-expanded on checkbox change", () => {
      expect(html).toContain("aria-expanded");
      expect(html).toContain("<script>");
      expect(html).toContain("change");
    });

    test("contains a Queue & Activity link pointing at /admin/queue-activity", () => {
      expect(html).toContain('href="/admin/queue-activity"');
      expect(html).toContain("Queue &amp; Activity");
    });

    // SESH-4.2: the Sessions link lives between Tasks and PRs.
    test("contains a Sessions link pointing at /admin/sessions, between Tasks and PRs", () => {
      expect(html).toContain('href="/admin/sessions"');
      expect(html).toContain(">Sessions<");
      const tasksIdx = html.indexOf('href="/admin/tasks"');
      const sessionsIdx = html.indexOf('href="/admin/sessions"');
      const prsIdx = html.indexOf('href="/admin/prs"');
      expect(tasksIdx).toBeGreaterThan(-1);
      expect(sessionsIdx).toBeGreaterThan(tasksIdx);
      expect(prsIdx).toBeGreaterThan(sessionsIdx);
    });
  });

  describe("active-tab highlighting: Agents vs Queue & Activity (AXR-3.3)", () => {
    function activeHref(html: string): string | undefined {
      const match = html.match(
        /<a href="([^"]+)" class="vos-nav-link active">/,
      );
      return match?.[1];
    }

    test("/admin/agents highlights the Agents tab, not Queue & Activity", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/agents");
      expect(html).toContain(
        '<a href="/admin/queue-activity" class="vos-nav-link">',
      );
    });

    test("/admin/agents/:id highlights the Agents tab, not Queue & Activity", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents/agent-123",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/agents");
      expect(html).toContain(
        '<a href="/admin/queue-activity" class="vos-nav-link">',
      );
    });

    test("/admin/agents/:id/queue-activity highlights Queue & Activity, not Agents", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents/agent-123/queue-activity",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/queue-activity");
      expect(html).toContain('<a href="/admin/agents" class="vos-nav-link">');
    });
  });

  describe("active-tab highlighting: Sessions (SESH-4.2)", () => {
    function activeHref(html: string): string | undefined {
      const match = html.match(
        /<a href="([^"]+)" class="vos-nav-link active">/,
      );
      return match?.[1];
    }

    test("/admin/sessions highlights the Sessions tab", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/sessions",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/sessions");
    });

    test("/admin/sessions/some-slug (session detail) also highlights the Sessions tab", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/sessions/some-slug",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/sessions");
    });
  });

  describe("read-only mode (readOnly=true)", () => {
    const html = renderShipwrightToolbar({
      userName: "",
      activePath: "/dashboard",
      logoutAction: "",
      readOnly: true,
    });

    test("contains hamburger button with class vos-hamburger", () => {
      expect(html).toContain("vos-hamburger");
    });

    test("hamburger button shows ☰ icon", () => {
      expect(html).toContain("☰");
    });

    test("contains only read-only nav links", () => {
      expect(html).toContain("Metrics");
      expect(html).toContain("Tasks");
    });

    test("does not contain authenticated-only links", () => {
      expect(html).not.toContain("Agents");
      expect(html).not.toContain("Sign out");
    });

    test("checkbox input appears before nav element in DOM", () => {
      expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<nav"));
    });

    test("hamburger label has aria-expanded attribute for screen reader feedback", () => {
      expect(html).toContain('aria-expanded="false"');
    });

    test("hamburger label has aria-controls pointing to nav content", () => {
      expect(html).toContain('aria-controls="vos-nav-content"');
    });

    test("nav content div has id for aria-controls target", () => {
      expect(html).toContain('id="vos-nav-content"');
    });

    test("includes JS shim to toggle aria-expanded on checkbox change", () => {
      expect(html).toContain("aria-expanded");
      expect(html).toContain("<script>");
      expect(html).toContain("change");
    });
  });
});

describe("renderShipwrightToolbar Account entry (SGL-2.3)", () => {
  test("never renders a top-level Account link (Settings covers it)", () => {
    const html = renderShipwrightToolbar({
      userName: "Alice",
      activePath: "/admin/agents",
      logoutAction: "/auth/logout",
      showSettings: true,
    });
    expect(html).not.toContain('href="/admin/account"');
  });
});

describe("renderShipwrightToolbar Settings entry (GHE-1.4)", () => {
  const base = {
    userName: "a@x.com",
    activePath: "/admin/settings/github-enterprise",
    logoutAction: "/admin/logout",
  };
  test("omitted by default", () => {
    expect(renderShipwrightToolbar(base)).not.toContain("/admin/settings");
  });
  test("rendered and active when showSettings is true", () => {
    const html = renderShipwrightToolbar({ ...base, showSettings: true });
    expect(html).toContain(
      'href="/admin/settings" class="vos-nav-link active">Settings</a>',
    );
  });
  test("active on any /admin/settings/* sub-page and links to /admin/settings", () => {
    const html = renderShipwrightToolbar({
      ...base,
      activePath: "/admin/settings/templates",
      showSettings: true,
    });
    expect(html).toContain(
      'href="/admin/settings" class="vos-nav-link active"',
    );
    expect(html).not.toContain('href="/admin/settings/github-enterprise"');
  });
  test("readOnly never renders it", () => {
    expect(
      renderShipwrightToolbar({ ...base, readOnly: true, showSettings: true }),
    ).not.toContain("/admin/settings");
  });
});

describe("renderShipwrightToolbar audience (MNAV-2.1)", () => {
  const base = {
    userName: "a@x.com",
    activePath: "/admin/agents",
    logoutAction: "/admin/logout",
  };
  const settings = 'href="/admin/settings"';

  test("admin sees every signed-in item including Settings", () => {
    const html = renderShipwrightToolbar({ ...base, audience: "admin" });
    expect(html).toContain(settings);
    expect(html).toContain("/admin/sessions");
    expect(html).toContain("Sign out");
  });
  test("member sees signed-in items but not Settings", () => {
    const html = renderShipwrightToolbar({ ...base, audience: "member" });
    expect(html).not.toContain(settings);
    expect(html).toContain("/admin/prs");
  });
  test("public renders the read-only variant", () => {
    const html = renderShipwrightToolbar({ ...base, audience: "public" });
    expect(html).not.toContain("/admin/");
    expect(html).not.toContain("Sign out");
    expect(html).toContain("/public/tasks");
  });
  test("audience admin output equals legacy showSettings output", () => {
    expect(renderShipwrightToolbar({ ...base, audience: "admin" })).toBe(
      renderShipwrightToolbar({ ...base, showSettings: true }),
    );
  });
  test("audience member output equals legacy default output", () => {
    expect(renderShipwrightToolbar({ ...base, audience: "member" })).toBe(
      renderShipwrightToolbar(base),
    );
  });
  test("legacy readOnly still works", () => {
    expect(renderShipwrightToolbar({ ...base, readOnly: true })).toBe(
      renderShipwrightToolbar({ ...base, audience: "public" }),
    );
  });
  test("legacy showSettings still adds Settings for a member", () => {
    expect(
      renderShipwrightToolbar({ ...base, audience: "member", showSettings: true }),
    ).toContain(settings);
  });
});

describe("TOOLBAR_NAV_ITEMS manifest", () => {
  const audiences = ["admin", "member", "public"] as const;
  test("every item renders for at least one audience", () => {
    for (const item of TOOLBAR_NAV_ITEMS) {
      expect(item.audiences.length).toBeGreaterThan(0);
    }
    const out = audiences.map((audience) =>
      renderShipwrightToolbar({
        userName: "a",
        activePath: "",
        logoutAction: "/x",
        audience,
      }),
    );
    for (const item of TOOLBAR_NAV_ITEMS) {
      const i = audiences.findIndex((a) => item.audiences.includes(a));
      expect(out[i]).toContain(`>${item.label.replace("&", "&amp;")}</a>`);
    }
  });
  test("Settings is admin only", () => {
    const s = TOOLBAR_NAV_ITEMS.find((i) => i.id === "settings");
    expect(s?.audiences).toEqual(["admin"]);
  });
  test("ids are unique", () => {
    const ids = TOOLBAR_NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
