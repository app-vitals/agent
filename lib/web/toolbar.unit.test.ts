/**
 * lib/web/toolbar.unit.test.ts
 * Pure unit tests for renderShipwrightToolbar().
 *
 * Strategy: call the render function directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import {
  baseStyles,
  renderShipwrightToolbar,
  THEME_PALETTES,
  THEME_STORAGE_KEY,
  TOOLBAR_NAV_ITEMS,
  themeBootScript,
  themeScript,
  themeVariables,
} from "./toolbar.ts";

describe("renderShipwrightToolbar", () => {
  describe("authenticated mode (member)", () => {
    const html = renderShipwrightToolbar({
      userName: "Alice",
      activePath: "/admin/agents",
      logoutAction: "/auth/logout",
      audience: "member",
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
        audience: "member",
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
        audience: "member",
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
        audience: "member",
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
        audience: "member",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/sessions");
    });

    test("/admin/sessions/some-slug (session detail) also highlights the Sessions tab", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/sessions/some-slug",
        audience: "member",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/sessions");
    });
  });

  describe("read-only mode (public)", () => {
    const html = renderShipwrightToolbar({
      userName: "",
      activePath: "/dashboard",
      logoutAction: "",
      audience: "public",
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
      audience: "admin",
    });
    expect(html).not.toContain('href="/admin/account"');
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

// ─── Light and dark theme ────────────────────────────────────────────────────

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme palettes", () => {
  test("light and dark define exactly the same tokens", () => {
    expect(Object.keys(THEME_PALETTES.dark).sort()).toEqual(
      Object.keys(THEME_PALETTES.light).sort(),
    );
  });

  test("every value is a 6-digit hex colour", () => {
    for (const palette of Object.values(THEME_PALETTES)) {
      for (const [name, value] of Object.entries(palette)) {
        expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  // [foreground token, background token]: pairs the UI actually renders.
  const TEXT_PAIRS: [string, string][] = [
    ["text", "bg"],
    ["text", "surface"],
    ["text-body", "surface"],
    ["text-muted", "surface"],
    ["text-muted", "bg"],
    ["brand", "brand-bg"],
    ["primary-text", "primary"],
    ["success-text", "success-bg"],
    ["warning-text", "warning-bg"],
    ["danger-text", "danger-bg"],
    ["info-text", "info-bg"],
    ["violet-text", "violet-bg"],
    ["teal-text", "teal-bg"],
  ];

  for (const [mode, palette] of Object.entries(THEME_PALETTES)) {
    test(`${mode}: text pairs meet WCAG AA (4.5:1)`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrast(palette[fg] as string, palette[bg] as string);
        expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("dark: faint text still meets AA on surfaces", () => {
    const dark = THEME_PALETTES.dark;
    expect(
      contrast(dark["text-faint"] as string, dark.surface as string),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("themeVariables / baseStyles", () => {
  test("declares the light palette on :root and the dark one on data-theme", () => {
    const css = themeVariables();
    expect(css).toContain(":root { color-scheme: light;");
    expect(css).toContain(':root[data-theme="dark"] { color-scheme: dark;');
    expect(css).toContain(`--vos-bg: ${THEME_PALETTES.light.bg};`);
    expect(css).toContain(`--vos-bg: ${THEME_PALETTES.dark.bg};`);
  });

  test("baseStyles carries the variables and uses no other hex colour", () => {
    const css = baseStyles();
    expect(css).toContain(themeVariables());
    const rest = css.replace(themeVariables(), "");
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rest).toContain("background: var(--vos-bg);");
  });
});

describe("theme toggle", () => {
  const OPTS = {
    userName: "Alice",
    activePath: "/admin/agents",
    logoutAction: "/admin/logout",
  };

  for (const audience of ["admin", "member", "public"] as const) {
    test(`${audience} toolbar renders the toggle and the theme script`, () => {
      const html = renderShipwrightToolbar({ ...OPTS, audience });
      expect(html).toContain(
        '<button type="button" id="vos-theme-toggle" class="vos-theme-toggle" aria-pressed="false">Dark mode</button>',
      );
      expect(html).toContain(themeScript());
    });
  }

  test("the script reads the saved choice, then the system preference", () => {
    const script = themeScript();
    expect(script).toContain(`k="${THEME_STORAGE_KEY}"`);
    expect(script).toContain("(prefers-color-scheme: dark)");
    expect(script).toContain('setAttribute("data-theme",t)');
    expect(script).toContain("vos-theme-change");
  });

  test("the head boot script is valid JavaScript and uses the same storage key", () => {
    const body = themeBootScript()
      .replace(/^<script>/, "")
      .replace(/<\/script>$/, "");
    expect(() => new Function(body)).not.toThrow();
    expect(body).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });

  test("the script is syntactically valid JavaScript", () => {
    const body = themeScript()
      .replace(/^<script>/, "")
      .replace(/<\/script>$/, "");
    expect(() => new Function(body)).not.toThrow();
  });
});
