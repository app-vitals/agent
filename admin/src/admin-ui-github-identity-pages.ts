/**
 * admin/src/admin-ui-github-identity-pages.ts
 * Pure renderers for the agent detail page's GitHub identity row and access
 * preview (GHE-2.5). Both are platform-admin only and shown only when the
 * enterprise GitHub apps are configured; the caller decides that. Every
 * dynamic value is escaped. The input is the GHE-2.4 preview, which carries
 * repo names and levels only (no token or key ever reaches this module).
 */

import { escapeHtml } from "./admin-ui-styles.ts";

export interface GithubAccessRepo {
  fullName: string;
  level: string;
  canPush: boolean;
}

export type GithubAccessOrgStatus =
  | "ok"
  | "lookup_app_not_installed"
  | "rate_limited"
  | "partial"
  | "error";

export interface GithubAccessOrg {
  org: string;
  status: GithubAccessOrgStatus;
  repos: GithubAccessRepo[];
  unresolved: number;
  /** Optional cause shown in the partial-results banner. */
  reason?: string;
}

/** JSON body of GET /agents/:id/github-access. */
export interface GithubAccessPreviewView {
  status: "ok" | "user_not_found" | "unconfigured";
  access?: {
    username: string;
    outcome: "ok" | "user_not_found";
    userVerified: boolean;
    orgs: GithubAccessOrg[];
    unresolved: number;
    complete: boolean;
    checkedAt: string;
  };
}

const STATUS_BADGES: Record<GithubAccessOrgStatus, [string, string]> = {
  ok: ["badge-green", "ok"],
  lookup_app_not_installed: ["badge-gray", "lookup app not installed"],
  rate_limited: ["badge-warning", "rate-limited"],
  partial: ["badge-warning", "partial"],
  error: ["badge-warning", "error"],
};

function statusBadge(status: string): string {
  const [cls, label] = STATUS_BADGES[status as GithubAccessOrgStatus] ?? [
    "badge-warning",
    status,
  ];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

/** The GitHub username `<tr>` for the "Owner & identities" card. */
export function renderGithubUsernameRow(
  agentId: string,
  username: string | null | undefined,
): string {
  const action = `/admin/agents/${escapeHtml(agentId)}/github-username`;
  const clear = username
    ? `<form method="POST" action="${action}" style="display:inline">
          <input type="hidden" name="githubUsername" value="" />
          <button type="submit" class="btn btn-danger" id="clear-github-username">Clear</button>
        </form>`
    : "";
  return `<tr><td style="color:#6b7280;width:200px">GitHub username</td><td>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <form method="POST" action="${action}" id="github-username-form" style="display:flex;gap:8px;align-items:center">
            <input name="githubUsername" type="text" class="form-input mono" maxlength="39" placeholder="GitHub login" value="${escapeHtml(username ?? "")}" required />
            <button type="submit" class="btn btn-primary">Save</button>
          </form>
          ${clear}
        </div>
      </td></tr>`;
}

/** The "Preview access" card; the button loads the fragment from the UI route. */
export function renderGithubAccessCard(agentId: string): string {
  const url = `/admin/agents/${escapeHtml(agentId)}/github-access`;
  return `<div class="card" id="github-access-card">
      <div class="card-title">Preview access</div>
      <p style="color:#6b7280;font-size:12px;margin:0 0 12px">Shows the repos this agent's GitHub user can reach. Read-only; nothing is stored.</p>
      <button type="button" class="btn btn-primary" id="github-access-btn" data-url="${url}">Preview access</button>
      <div id="github-access-result" style="margin-top:12px"></div>
      <script>
        (function() {
          var btn = document.getElementById('github-access-btn');
          var out = document.getElementById('github-access-result');
          if (!btn || !out) return;
          btn.addEventListener('click', function() {
            btn.disabled = true;
            out.textContent = 'Loading...';
            fetch(btn.getAttribute('data-url'), { credentials: 'same-origin' })
              .then(function(r) { return r.text(); })
              .then(function(t) { out.innerHTML = t; })
              .catch(function() { out.textContent = 'The request failed.'; })
              .then(function() { btn.disabled = false; });
          });
        })();
      </script>
    </div>`;
}

/** Fragment rendered into the preview card; also the body of the UI route. */
export function renderGithubAccessResult(
  preview: GithubAccessPreviewView,
): string {
  if (preview.status === "unconfigured") {
    return `<div class="alert alert-warning">The enterprise GitHub apps are not configured.</div>`;
  }
  const access = preview.access;
  if (
    preview.status === "user_not_found" ||
    access?.outcome === "user_not_found"
  ) {
    const who = access?.username ? ` "${escapeHtml(access.username)}"` : "";
    return `<div class="alert alert-warning">GitHub user${who} was not found.</div>`;
  }
  if (!access) return renderGithubAccessError("No preview was returned.");

  const orgs = access.orgs;
  const reasons = orgs
    .filter((o) => o.reason)
    .map((o) => `${escapeHtml(o.org)}: ${escapeHtml(o.reason ?? "")}`)
    .join("; ");
  const warn =
    !access.complete || orgs.some((o) => o.status !== "ok")
      ? `<div class="alert alert-warning">Partial results: some organizations or repos could not be checked${access.unresolved > 0 ? ` (${access.unresolved} unresolved)` : ""}. Repos that are not listed are unknown, not necessarily inaccessible.${reasons ? ` ${reasons}.` : ""}</div>`
      : "";
  if (orgs.length === 0) {
    return `${warn}<p class="empty-state">No organizations to check.</p>`;
  }
  const groups = orgs
    .map((o) => {
      const rows =
        o.repos.length === 0
          ? `<tr><td colspan="3" class="empty-state">No repos.</td></tr>`
          : o.repos
              .map(
                (r) =>
                  `<tr><td class="mono">${escapeHtml(r.fullName)}</td><td>${escapeHtml(r.level)}</td><td>${r.canPush ? '<span class="badge badge-green" title="Can push">push</span>' : ""}</td></tr>`,
              )
              .join("");
      const unresolved =
        o.unresolved > 0
          ? ` <span style="color:#6b7280;font-size:12px">${o.unresolved} unresolved</span>`
          : "";
      return `<div class="github-access-org" style="margin-bottom:16px">
        <div style="font-weight:600;margin-bottom:6px">${escapeHtml(o.org)} ${statusBadge(o.status)}${unresolved}</div>
        <table class="detail-table"><thead><tr><th>Repo</th><th>Level</th><th>Push</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    })
    .join("");
  return `${warn}${groups}`;
}

export function renderGithubAccessError(message: string): string {
  return `<div class="alert alert-error">${escapeHtml(message)}</div>`;
}
