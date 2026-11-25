/**
 * lib/web/toolbar.ts
 * Shared Shipwright toolbar — used by both the metrics dashboard and the admin UI.
 */

/**
 * Who is viewing the toolbar. `admin` = admins, owners and account members; `member` = any other
 * signed-in user; `public` = the unauthenticated read-only proof host.
 */
export type ToolbarAudience = "admin" | "member" | "public";

export type ToolbarNavItemId =
  | "agents"
  | "tasks"
  | "sessions"
  | "prs"
  | "chat"
  | "queue-activity"
  | "settings"
  | "metrics"
  | "public-tasks";

export interface ToolbarNavItem {
  id: ToolbarNavItemId;
  label: string;
  /** Audiences that see this item. */
  audiences: readonly ToolbarAudience[];
}

const SIGNED_IN: readonly ToolbarAudience[] = ["admin", "member"];

/** Nav manifest, in render order: which audiences see each item. */
export const TOOLBAR_NAV_ITEMS: readonly ToolbarNavItem[] = [
  { id: "agents", label: "Agents", audiences: SIGNED_IN },
  { id: "tasks", label: "Tasks", audiences: SIGNED_IN },
  { id: "sessions", label: "Sessions", audiences: SIGNED_IN },
  { id: "prs", label: "PRs", audiences: SIGNED_IN },
  { id: "chat", label: "Chat", audiences: SIGNED_IN },
  { id: "queue-activity", label: "Queue & Activity", audiences: SIGNED_IN },
  { id: "settings", label: "Settings", audiences: ["admin"] },
  { id: "metrics", label: "Metrics", audiences: ["admin", "member", "public"] },
  { id: "public-tasks", label: "Tasks", audiences: ["public"] },
];

export interface ShipwrightToolbarOptions {
  /**
   * Who is viewing. Nav visibility derives from {@link TOOLBAR_NAV_ITEMS}.
   * `public` renders the read-only variant (Metrics + public task board, no
   * sign-out).
   */
  audience: ToolbarAudience;
  userName: string;
  /** Current request path, used to highlight the active nav link. */
  activePath: string;
  /** Form action for the sign-out button (differs per service). */
  logoutAction: string;
  /** Full URL of the metrics dashboard. Defaults to "/dashboard". */
  metricsUrl?: string;
  /** Base URL of the admin service. Defaults to empty string (same origin). */
  adminBaseUrl?: string;
  /** Public task board URL, used only for the public audience. Defaults to "/public/tasks". */
  tasksUrl?: string;
}

/** localStorage key holding the visitor's saved theme: "light" or "dark". */
export const THEME_STORAGE_KEY = "shipwright-theme";

/** Light palette (`:root`) and dark palette (`:root[data-theme="dark"]`). */
const THEME_LIGHT: Record<string, string> = {
  bg: "#f7f7fb",
  surface: "#ffffff",
  "surface-muted": "#f9fafb",
  "surface-subtle": "#f3f4f6",
  border: "#e8e8ee",
  "border-strong": "#d1d5db",
  text: "#1a1a2e",
  "text-body": "#374151",
  "text-muted": "#6b7280",
  "text-faint": "#9ca3af",
  brand: "#4f46e5",
  "brand-strong": "#4338ca",
  "brand-bg": "#eef2ff",
  "brand-border": "#c7d2fe",
  primary: "#1a1a2e",
  "primary-hover": "#2d2d4e",
  "primary-text": "#ffffff",
  "success-bg": "#d1fae5",
  "success-text": "#065f46",
  "success-border": "#a7f3d0",
  "warning-bg": "#fef3c7",
  "warning-text": "#92400e",
  "warning-border": "#fde68a",
  danger: "#dc2626",
  "danger-text": "#b91c1c",
  "danger-bg": "#fee2e2",
  "danger-border": "#fecaca",
  "info-bg": "#dbeafe",
  "info-text": "#1e40af",
  "info-border": "#93c5fd",
  "violet-bg": "#ede9fe",
  "violet-text": "#5b21b6",
  "teal-bg": "#ccfbf1",
  "teal-text": "#0f766e",
};

const THEME_DARK: Record<string, string> = {
  bg: "#0f1117",
  surface: "#171a22",
  "surface-muted": "#1b1f29",
  "surface-subtle": "#1f2330",
  border: "#2a2f3d",
  "border-strong": "#3a4052",
  text: "#e6e8ef",
  "text-body": "#c9cdd8",
  "text-muted": "#a3a9b8",
  "text-faint": "#8891a3",
  brand: "#818cf8",
  "brand-strong": "#a5b4fc",
  "brand-bg": "#23264a",
  "brand-border": "#3b3f7a",
  primary: "#e6e8ef",
  "primary-hover": "#ffffff",
  "primary-text": "#0f1117",
  "success-bg": "#0f2e1d",
  "success-text": "#86efac",
  "success-border": "#14532d",
  "warning-bg": "#3a2a0c",
  "warning-text": "#fcd34d",
  "warning-border": "#78350f",
  danger: "#f87171",
  "danger-text": "#fca5a5",
  "danger-bg": "#3b1518",
  "danger-border": "#7f1d1d",
  "info-bg": "#16264a",
  "info-text": "#93c5fd",
  "info-border": "#1e3a8a",
  "violet-bg": "#2a1f4d",
  "violet-text": "#c4b5fd",
  "teal-bg": "#0f2f2c",
  "teal-text": "#5eead4",
};

/** The two palettes as plain objects, keyed by token name (no `--vos-` prefix). */
export const THEME_PALETTES = { light: THEME_LIGHT, dark: THEME_DARK } as const;

function declarations(palette: Record<string, string>): string {
  return Object.entries(palette)
    .map(([name, value]) => `--vos-${name}: ${value};`)
    .join(" ");
}

/**
 * CSS custom properties for both themes. Every page that includes
 * {@link baseStyles} gets them; `data-theme` on `<html>` picks the palette
 * and is set by the script in {@link renderShipwrightToolbar}.
 */
export function themeVariables(): string {
  return `:root { color-scheme: light; ${declarations(THEME_LIGHT)} }
    :root[data-theme="dark"] { color-scheme: dark; ${declarations(THEME_DARK)} }
    :root[data-theme="dark"] textarea, :root[data-theme="dark"] select, :root[data-theme="dark"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]) { background-color: var(--vos-surface); color: var(--vos-text); }`;
}

/**
 * Minimal `<head>` script: sets `data-theme` before the first paint, for pages
 * that render their own document shell (and for pages with no toolbar, such as
 * sign-in). Same resolution order as {@link themeScript}.
 */
export function themeBootScript(): string {
  const key = JSON.stringify(THEME_STORAGE_KEY);
  return `<script>(function(){var t="light";try{var s=localStorage.getItem(${key});if(s==="dark"||s==="light"){t=s}else if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches){t="dark"}}catch(e){}document.documentElement.setAttribute("data-theme",t)})();</script>`;
}

/**
 * Inline script that applies the theme and wires the toolbar toggle. It runs
 * as the toolbar is parsed, at the top of <body>, so the page does not paint
 * light first. A saved choice wins; otherwise the system preference; storage
 * or matchMedia being unavailable falls back to light. Changing the theme
 * fires a `vos-theme-change` event on `document` for pages that draw to canvas.
 */
export function themeScript(): string {
  const key = JSON.stringify(THEME_STORAGE_KEY);
  return `<script>(function(){var d=document,r=d.documentElement,k=${key},q=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;function saved(){try{var s=localStorage.getItem(k);return s==="dark"||s==="light"?s:null}catch(e){return null}}function apply(t){r.setAttribute("data-theme",t);var b=d.getElementById("vos-theme-toggle");if(b)b.setAttribute("aria-pressed",t==="dark"?"true":"false");d.dispatchEvent(new CustomEvent("vos-theme-change",{detail:{theme:t}}))}apply(saved()||(q&&q.matches?"dark":"light"));var b=d.getElementById("vos-theme-toggle");if(b)b.addEventListener("click",function(){var t=r.getAttribute("data-theme")==="dark"?"light":"dark";try{localStorage.setItem(k,t)}catch(e){}apply(t)});if(q&&q.addEventListener)q.addEventListener("change",function(e){if(!saved())apply(e.matches?"dark":"light")})})();</script>`;
}

const THEME_TOGGLE =
  '<button type="button" id="vos-theme-toggle" class="vos-theme-toggle" aria-pressed="false">Dark mode</button>';

export function baseStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${themeVariables()}
    html { font-size: 16px; -webkit-font-smoothing: antialiased; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--vos-bg);
      color: var(--vos-text);
      min-height: 100vh;
    }

    /* ─── Toolbar ───────────────────────────────────────── */
    .vos-toolbar {
      background: var(--vos-surface);
      border-bottom: 1px solid var(--vos-border);
      height: 52px;
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 24px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .vos-wordmark {
      font-size: 15px;
      font-weight: 700;
      color: var(--vos-text);
      text-decoration: none;
      letter-spacing: -0.3px;
      flex-shrink: 0;
    }
    .vos-wordmark:hover { color: var(--vos-brand); }
    .vos-nav {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
    }
    .vos-nav-link {
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--vos-text-muted);
      text-decoration: none;
      transition: background 0.1s, color 0.1s;
      white-space: nowrap;
    }
    .vos-nav-link:hover { background: var(--vos-surface-subtle); color: var(--vos-text); }
    .vos-nav-link.active {
      background: var(--vos-brand-bg);
      color: var(--vos-brand);
      font-weight: 600;
    }
    .vos-user {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      margin-left: auto;
    }
    .vos-username {
      font-size: 13px;
      color: var(--vos-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }
    .vos-signout-btn {
      font-size: 13px;
      font-weight: 500;
      color: var(--vos-text-muted);
      background: none;
      border: 1px solid var(--vos-border);
      border-radius: 6px;
      padding: 5px 12px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
      white-space: nowrap;
    }
    .vos-signout-btn:hover { background: var(--vos-bg); color: var(--vos-text); border-color: var(--vos-border-strong); }

    /* ─── Page body ─────────────────────────────────────── */
    .vos-theme-toggle {
      font-size: 13px;
      font-weight: 500;
      color: var(--vos-text-muted);
      background: none;
      border: 1px solid var(--vos-border);
      border-radius: 6px;
      padding: 5px 12px;
      min-height: 28px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .vos-theme-toggle:hover { background: var(--vos-bg); color: var(--vos-text); border-color: var(--vos-border-strong); }
    .vos-theme-toggle[aria-pressed="true"] { background: var(--vos-brand-bg); color: var(--vos-brand); border-color: var(--vos-brand-border); }
    .vos-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }
    .vos-page-wide { max-width: none; width: 100%; }

    /* ─── Hamburger toggle (CSS-only, no JS) ───────────── */
    .vos-nav-toggle { display: none; }
    .vos-hamburger {
      display: none;
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--vos-text);
      padding: 4px 8px;
      line-height: 1;
      font-family: inherit;
    }
    .vos-hamburger:hover { color: var(--vos-brand); }

    @media (max-width: 640px) {
      .vos-toolbar { padding: 0 16px; gap: 12px; flex-wrap: wrap; height: auto; min-height: 52px; align-items: center; }
      .vos-username { display: none; }
      .vos-nav-link { padding: 5px 8px; }
      .vos-page { padding: 20px 16px 48px; }

      /* Hide nav links by default on mobile */
      .vos-nav {
        display: none;
        flex-direction: column;
        width: 100%;
        gap: 2px;
        padding: 8px 0;
        order: 3;
      }
      /* Show nav links when hamburger checkbox is checked */
      .vos-nav-toggle:checked + nav .vos-nav {
        display: flex;
      }
      .vos-nav-link {
        display: block;
        padding: 10px 12px;
        border-radius: 6px;
        font-size: 14px;
      }
      .vos-nav-link.active {
        background: var(--vos-brand-bg);
        color: var(--vos-brand);
        font-weight: 600;
      }
      /* Show hamburger on mobile */
      .vos-hamburger {
        display: block;
      }
      /* Hide user section sign-out on mobile when nav is closed */
      .vos-user {
        order: 2;
        margin-left: 0;
      }
    }

  `;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderShipwrightToolbar(
  opts: ShipwrightToolbarOptions,
): string {
  const { userName, activePath, logoutAction } = opts;
  const metricsUrl = opts.metricsUrl ?? "/dashboard";
  const adminBase = opts.adminBaseUrl ?? "";
  const active = (prefix: string) =>
    activePath.startsWith(prefix) ? " active" : "";
  // /admin/agents/:id/queue-activity starts with /admin/agents, so without
  // this special case both "Agents" and "Queue & Activity" would highlight
  // simultaneously on that page. Any path containing "/queue-activity"
  // belongs to the new tab instead.
  const isQueueActivity = activePath.includes("/queue-activity");

  const audience = opts.audience;
  const visible = (id: ToolbarNavItemId): boolean =>
    TOOLBAR_NAV_ITEMS.find((i) => i.id === id)?.audiences.includes(audience) ??
    false;

  // Public proof surface: only the read-only Metrics + Tasks views are routed and
  // reachable, so omit every /admin/* link and the sign-out form (they 404 on the
  // public host). The wordmark points at the dashboard instead of /admin/agents.
  if (audience === "public") {
    const tasksUrl = opts.tasksUrl ?? "/public/tasks";
    return `<input type="checkbox" id="vos-nav-toggle" class="vos-nav-toggle" aria-hidden="true">
  <nav class="vos-toolbar" aria-label="Site navigation">
    <a href="${metricsUrl}" class="vos-wordmark">Shipwright</a>
    <div id="vos-nav-content" class="vos-nav">
      <a href="${metricsUrl}" class="vos-nav-link${active(metricsUrl)}">Metrics</a>
      <a href="${tasksUrl}" class="vos-nav-link${active(tasksUrl)}">Tasks</a>
    </div>
    <div class="vos-user">
      ${THEME_TOGGLE}
    </div>
    <label for="vos-nav-toggle" class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="vos-nav-content">☰</label>
  </nav>
  <script>(function(){var t=document.getElementById('vos-nav-toggle');if(t)t.addEventListener('change',function(){var l=document.querySelector('label[for="vos-nav-toggle"]');if(l)l.setAttribute('aria-expanded',t.checked?'true':'false');});})();</script>
  ${themeScript()}`;
  }

  const hrefs: Record<string, string> = {
    agents: `/admin/agents`,
    tasks: `/admin/tasks`,
    sessions: `/admin/sessions`,
    prs: `/admin/prs`,
    chat: `/admin/chat`,
    "queue-activity": `/admin/queue-activity`,
    settings: `/admin/settings`,
  };
  const links = TOOLBAR_NAV_ITEMS.filter(
    (i) => i.id !== "public-tasks" && visible(i.id),
  )
    .map((i) => {
      if (i.id === "metrics") {
        return `<a href="${metricsUrl}" class="vos-nav-link${active(metricsUrl)}">${i.label}</a>`;
      }
      const path = hrefs[i.id] as string;
      const on =
        i.id === "agents"
          ? isQueueActivity
            ? ""
            : active(path)
          : i.id === "queue-activity"
            ? isQueueActivity
              ? " active"
              : ""
            : active(path);
      return `<a href="${adminBase}${path}" class="vos-nav-link${on}">${escapeHtml(i.label)}</a>`;
    })
    .join("\n      ");

  return `<input type="checkbox" id="vos-nav-toggle" class="vos-nav-toggle" aria-hidden="true">
  <nav class="vos-toolbar" aria-label="Site navigation">
    <a href="${adminBase}/admin/agents" class="vos-wordmark">Shipwright</a>
    <div id="vos-nav-content" class="vos-nav">
      ${links}
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      ${THEME_TOGGLE}
      <form method="POST" action="${logoutAction}" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
    <label for="vos-nav-toggle" class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="vos-nav-content">☰</label>
  </nav>
  <script>(function(){var t=document.getElementById('vos-nav-toggle');if(t)t.addEventListener('change',function(){var l=document.querySelector('label[for="vos-nav-toggle"]');if(l)l.setAttribute('aria-expanded',t.checked?'true':'false');});})();</script>
  ${themeScript()}`;
}
