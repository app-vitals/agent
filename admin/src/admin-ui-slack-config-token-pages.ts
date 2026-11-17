/**
 * admin/src/admin-ui-slack-config-token-pages.ts
 * Render function for Settings > Slack config token (SCT-3.1).
 * Pure string -> string; routes live in admin-ui-slack-config-token.ts.
 *
 * The page only ever receives metadata (configured, last rotated, last error,
 * team/user): there is no field through which a refresh or access token could
 * reach the markup. The paste input is never pre-filled.
 */

import { renderAdminPage } from "./admin-ui-layout.ts";
import {
  buildSettingsNav,
  renderSettingsLayout,
  type SettingsNav,
} from "./admin-ui-settings-layout.ts";
import { escapeHtml } from "./admin-ui-styles.ts";

export const ADMIN_SLACK_CONFIG_TOKEN_PATH =
  "/admin/settings/slack-config-token";

const BASE = ADMIN_SLACK_CONFIG_TOKEN_PATH;

export interface SlackConfigTokenScopeOption {
  value: string;
  label: string;
}

/** Display-only status of the row at the selected scope. */
export interface SlackConfigTokenStatusView {
  lastRotatedAt: Date | null;
  lastError: string | null;
  slackTeamId: string | null;
  slackUserId: string | null;
}

export interface SlackConfigTokenPageOpts {
  userEmail: string;
  isAdmin?: boolean;
  nav?: SettingsNav;
  /** Accounts the caller may pick; the deployment-wide option only for admins. */
  accountOptions: SlackConfigTokenScopeOption[];
  /** Selected scope ("" = deployment-wide). */
  accountId: string;
  /** Row at the selected scope, or null when not configured. */
  status: SlackConfigTokenStatusView | null;
  /** SHIPWRIGHT_ENCRYPTION_KEY is set; without it saving is refused. */
  encryptionConfigured: boolean;
  error?: string;
  notice?: string;
}

function accountPicker(o: SlackConfigTokenPageOpts): string {
  const opts = o.accountOptions
    .map(
      (a) =>
        `<option value="${escapeHtml(a.value)}"${a.value === o.accountId ? " selected" : ""}>${escapeHtml(a.label)}</option>`,
    )
    .join("");
  return `<form method="GET" action="${BASE}" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <label>Account <select name="accountId" class="form-input">${opts}</select></label>
      <button type="submit" class="btn btn-secondary">Open</button>
    </form>`;
}

function scopeField(o: SlackConfigTokenPageOpts): string {
  return `<input type="hidden" name="accountId" value="${escapeHtml(o.accountId)}" />`;
}

const when = (d: Date | null): string =>
  d ? escapeHtml(d.toISOString()) : "never";

function statusCard(o: SlackConfigTokenPageOpts): string {
  const s = o.status;
  if (!s) {
    return `<p class="help-text">Not configured for this scope.</p>`;
  }
  const team =
    s.slackTeamId || s.slackUserId
      ? `${escapeHtml(s.slackTeamId ?? "?")} / ${escapeHtml(s.slackUserId ?? "?")}`
      : "unknown";
  return `<table class="data-table"><tbody>
      <tr><th>Configured</th><td>Yes</td></tr>
      <tr><th>Last rotated</th><td>${when(s.lastRotatedAt)}</td></tr>
      <tr><th>Last error</th><td>${s.lastError ? escapeHtml(s.lastError) : "none"}</td></tr>
      <tr><th>Team / user</th><td>${team}</td></tr>
    </tbody></table>
    <div style="display:flex;gap:8px;margin-top:12px">
      <form method="POST" action="${BASE}/rotate">${scopeField(o)}<button type="submit" class="btn btn-secondary">Rotate now</button></form>
      <form method="POST" action="${BASE}/clear">${scopeField(o)}<button type="submit" class="btn btn-danger">Clear token</button></form>
    </div>`;
}

export function renderSlackConfigTokenPage(
  o: SlackConfigTokenPageOpts,
): string {
  const error = o.error
    ? `<div class="alert alert-error">${escapeHtml(o.error)}</div>`
    : "";
  const notice = o.notice
    ? `<div class="alert alert-success">${escapeHtml(o.notice)}</div>`
    : "";
  const encryptionWarning = o.encryptionConfigured
    ? ""
    : `<div class="alert alert-error">SHIPWRIGHT_ENCRYPTION_KEY is not configured, so a Slack config token cannot be saved. Set it to a 64-character hex string (openssl rand -hex 32) and restart.</div>`;
  return renderAdminPage({
    title: "Slack config token — Settings — Shipwright Admin",
    body: renderSettingsLayout({
      userName: o.userEmail,
      title: "Slack config token",
      nav:
        o.nav ??
        buildSettingsNav({ githubEnterprise: true, slackConfigToken: true }),
      active: BASE,
      isAdmin: o.isAdmin ?? false,
      body: `${error}${notice}${encryptionWarning}
    <div class="card">
      <p class="help-text">The Slack App Configuration token used to create and update agent Slack apps. A deployment-wide token is the default; an account's own token overrides it. Tokens are stored encrypted and never shown.</p>
      ${accountPicker(o)}
    </div>
    <div class="card">
      <div class="card-title">Status</div>
      ${statusCard(o)}
    </div>
    <div class="card">
      <div class="card-title">${o.status ? "Replace refresh token" : "Add refresh token"}</div>
      <form method="POST" action="${BASE}/save" style="display:grid;gap:8px;max-width:480px">
        ${scopeField(o)}
        <label>Refresh token (xoxe-1-...) <input type="password" name="refreshToken" class="form-input" autocomplete="off" required placeholder="xoxe-1-..." /></label>
        <p class="help-text">Generate it at api.slack.com/apps under Your App Configuration Tokens. It is validated by rotating it once; the rotated pair is stored.</p>
        <div><button type="submit" class="btn btn-primary"${o.encryptionConfigured ? "" : " disabled"}>Validate and save</button></div>
      </form>
    </div>`,
    }),
  });
}
