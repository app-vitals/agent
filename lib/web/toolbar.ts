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

export function baseStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; -webkit-font-smoothing: antialiased; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f7f7fb;
      color: #1a1a2e;
      min-height: 100vh;
    }

    /* ─── Toolbar ───────────────────────────────────────── */
    .vos-toolbar {
      background: #fff;
      border-bottom: 1px solid #e8e8ee;
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
      color: #1a1a2e;
      text-decoration: none;
      letter-spacing: -0.3px;
      flex-shrink: 0;
    }
    .vos-wordmark:hover { color: #4f46e5; }
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
      color: #6b7280;
      text-decoration: none;
      transition: background 0.1s, color 0.1s;
      white-space: nowrap;
    }
    .vos-nav-link:hover { background: #f3f4f6; color: #1a1a2e; }
    .vos-nav-link.active {
      background: #eef2ff;
      color: #4f46e5;
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
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }
    .vos-signout-btn {
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      background: none;
      border: 1px solid #e8e8ee;
      border-radius: 6px;
      padding: 5px 12px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
      white-space: nowrap;
    }
    .vos-signout-btn:hover { background: #f7f7fb; color: #1a1a2e; border-color: #d1d5db; }

    /* ─── Page body ─────────────────────────────────────── */
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
      color: #1a1a2e;
      padding: 4px 8px;
      line-height: 1;
      font-family: inherit;
    }
    .vos-hamburger:hover { color: #4f46e5; }

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
        background: #eef2ff;
        color: #4f46e5;
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
    <label for="vos-nav-toggle" class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="vos-nav-content">☰</label>
  </nav>
  <script>(function(){var t=document.getElementById('vos-nav-toggle');if(t)t.addEventListener('change',function(){var l=document.querySelector('label[for="vos-nav-toggle"]');if(l)l.setAttribute('aria-expanded',t.checked?'true':'false');});})();</script>`;
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
      <form method="POST" action="${logoutAction}" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
    <label for="vos-nav-toggle" class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="vos-nav-content">☰</label>
  </nav>
  <script>(function(){var t=document.getElementById('vos-nav-toggle');if(t)t.addEventListener('change',function(){var l=document.querySelector('label[for="vos-nav-toggle"]');if(l)l.setAttribute('aria-expanded',t.checked?'true':'false');});})();</script>`;
}
