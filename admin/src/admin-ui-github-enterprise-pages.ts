/**
 * admin/src/admin-ui-github-enterprise-pages.ts
 * Render function for the enterprise GitHub apps settings page (GHE-1.4).
 * Pure string -> string; routes live in admin-ui-github-enterprise.ts.
 *
 * Credentials are paste-only: the forms accept the private key but the page
 * never renders a key (the status API only reports `keySet`).
 */

import {
  GHE_WARNINGS,
  type GheWarningCode,
} from "./github-enterprise-warnings.ts";
import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";

export const ADMIN_GITHUB_ENTERPRISE_PATH = "/admin/settings/github-enterprise";

/** GithubEnterpriseApp shape returned by GET /github-enterprise/apps. */
export interface GheApp {
  role: string;
  appId: string;
  slug: string;
  enterpriseSlug: string | null;
  keySet: boolean;
  lastValidationStatus: string | null;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GheStatus {
  configured: boolean;
  installer: GheApp | null;
  lookup: GheApp | null;
}

export interface GheOrg {
  id: number;
  login: string;
  lookupAppInstalled: boolean | null;
  agentAppInstalled: boolean | null;
}

export interface GheOrgs {
  configured: boolean;
  agentAppSlug?: string | null;
  /** Why the agent's App cannot be installed (e.g. private, no client id). */
  agentAppReason?: string | null;
  orgs: GheOrg[];
}

export interface GithubEnterpriseSettingsPageOpts {
  userEmail: string;
  status: GheStatus;
  /** Present when the installer App is configured and the org list loaded. */
  orgs?: GheOrgs;
  /** Readable message when the org list could not be loaded. */
  orgsError?: string;
  /** Agent whose App the install actions target (carried via ?agentId=). */
  agentId?: string;
  error?: string;
  notice?: string;
  /** Warning codes from the last validate (carried via ?warn=); unknown codes are ignored. */
  warnings?: string[];
}

const BASE = ADMIN_GITHUB_ENTERPRISE_PATH;

/** "2026-11-09T12:00:00.000Z" -> "2026-11-09 12:00 UTC". */
function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function validationBadge(status: string | null): string {
  if (!status) return `<span class="badge badge-gray">Not validated yet</span>`;
  const cls = status === "valid" ? "badge-green" : "badge-warning";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

const ROLE_COPY = {
  installer: {
    title: "Installer app",
    descriptor:
      "Auto-installs agents' GitHub Apps on your enterprise's organizations.",
    steps: [
      "In GitHub, open your enterprise's Settings &rarr; GitHub Apps &rarr; New GitHub App (an enterprise-owned App).",
      "Under Enterprise permissions, grant both <code>enterprise_organization_installations</code> and <code>enterprise_organization_installation_repositories</code> at <strong>Read and write</strong>.",
      "Create the App. The App ID is on the App's settings page; the App slug is the last part of its public URL (<code>github.com/apps/&lt;slug&gt;</code>).",
      "The enterprise slug is the last part of your enterprise's URL (<code>github.com/enterprises/&lt;slug&gt;</code>).",
      "Under Private keys, choose Generate a private key and paste the downloaded PEM below.",
    ],
  },
  lookup: {
    title: "Lookup app",
    descriptor:
      "Read-only App that gives the platform repository access lookups. Optional.",
    steps: [
      "In GitHub, open your organization's Settings &rarr; Developer settings &rarr; GitHub Apps &rarr; New GitHub App.",
      "Grant Repository <code>Metadata</code> at <strong>Read</strong> and Organization <code>Members</code> at <strong>Read</strong>.",
      "Create the App. The App ID is on the App's settings page; the App slug is the last part of its public URL (<code>github.com/apps/&lt;slug&gt;</code>).",
      "It must be installed on all repositories of each organization, not selected repositories only.",
      "Under Private keys, choose Generate a private key and paste the downloaded PEM below.",
    ],
  },
} as const;

const IGNORED_OPTIONS =
  "Ignore these options: callback URL, request user authorization, expire user authorization tokens, device flow, and webhook (uncheck Active).";

function guidance(role: "installer" | "lookup"): string {
  const copy = ROLE_COPY[role];
  return `<ol class="help-text gh-ent-steps" style="font-size:12px;margin:8px 0;padding-left:20px">${copy.steps.map((x) => `<li>${x}</li>`).join("")}</ol>
      <p class="help-text gh-ent-ignore" style="font-size:12px;margin:8px 0">${IGNORED_OPTIONS}</p>`;
}

function statusLine(app: GheApp): string {
  const validated = app.lastValidatedAt
    ? ` &middot; ${escapeHtml(formatTime(app.lastValidatedAt))}`
    : "";
  const error = app.lastValidationError
    ? `<div class="help-text" style="font-size:12px;margin-top:4px">${escapeHtml(app.lastValidationError)}</div>`
    : "";
  return `<div class="gh-ent-status">
      <span class="badge badge-green">Configured</span>
      <span class="badge ${app.keySet ? "badge-green" : "badge-warning"}">${app.keySet ? "Key set" : "Key not set"}</span>
      ${validationBadge(app.lastValidationStatus)}${validated}
      ${error}
    </div>`;
}

function postButton(
  action: string,
  label: string,
  cls = "btn-secondary",
): string {
  return `<form method="POST" action="${action}" style="display:inline;margin:0"><button type="submit" class="btn ${cls}" style="font-size:12px;padding:4px 10px">${label}</button></form>`;
}

function warningsBlock(
  role: "installer" | "lookup",
  codes: string[] | undefined,
): string {
  return (codes ?? [])
    .filter(
      (c): c is GheWarningCode => c in GHE_WARNINGS && c.startsWith(`${role}_`),
    )
    .map(
      (c) =>
        `<div class="help-text gh-ent-warning" style="font-size:12px;margin-top:4px">Warning: ${escapeHtml(GHE_WARNINGS[c])}</div>`,
    )
    .join("");
}

function appCard(
  role: "installer" | "lookup",
  app: GheApp | null,
  warnings?: string[],
): string {
  const copy = ROLE_COPY[role];
  const action = `${BASE}/apps/${role}`;
  const summary = app
    ? `<p style="margin:8px 0">App ID <strong>${escapeHtml(app.appId)}</strong> &middot; slug <strong>${escapeHtml(app.slug)}</strong>${app.enterpriseSlug ? ` &middot; enterprise <strong>${escapeHtml(app.enterpriseSlug)}</strong>` : ""}</p>
    ${statusLine(app)}${warningsBlock(role, warnings)}
    <div style="display:flex;gap:8px;margin:12px 0">${postButton(`${action}/validate`, "Validate")}${postButton(`${action}/delete`, "Delete", "btn-danger")}</div>`
    : `<p class="help-text" style="font-size:12px;margin:8px 0">Not configured.</p>`;
  const enterprise =
    role === "installer"
      ? `<label>Enterprise slug <input name="enterpriseSlug" class="form-input" required placeholder="my-enterprise" /></label>`
      : "";
  return `<div class="card">
      <div class="card-title">${copy.title}</div>
      <p class="help-text" style="font-size:12px">${copy.descriptor}</p>
      ${guidance(role)}
      ${summary}
      <form method="POST" action="${action}" enctype="multipart/form-data" style="display:grid;gap:8px;max-width:480px">
        <label>App ID <input name="appId" class="form-input" required inputmode="numeric" pattern="[0-9]+" /></label>
        <label>App slug <input name="slug" class="form-input" required /></label>
        ${enterprise}
        <label>Private key (PEM) <textarea name="privateKey" class="form-input" rows="4" autocomplete="off" spellcheck="false" placeholder="Paste the private key. It is stored encrypted and never shown again."></textarea></label>
        <label>Or upload the .pem file <input type="file" name="privateKeyFile" accept=".pem,application/x-pem-file" class="form-input" /></label>
        <div><button type="submit" class="btn btn-primary">${app ? "Replace credentials" : "Save credentials"}</button></div>
      </form>
    </div>`;
}

function installedCell(v: boolean | null): string {
  if (v === null) return "&mdash;";
  return v
    ? `<span class="badge badge-green">Installed</span>`
    : `<span class="badge badge-gray">Not installed</span>`;
}

function orgsCard(opts: GithubEnterpriseSettingsPageOpts): string {
  const { status } = opts;
  if (!status.installer) return "";
  const agentId = opts.agentId ?? "";
  const lookupSlug = status.lookup?.slug;

  const filter = `<form method="GET" action="${BASE}" style="display:flex;gap:8px;margin:8px 0">
        <input name="agentId" class="form-input" placeholder="Agent ID (to check its App)" value="${escapeHtml(agentId)}" style="max-width:280px" />
        <button type="submit" class="btn btn-secondary">Check agent</button>
      </form>`;

  let body: string;
  if (opts.orgsError) {
    body = `<div class="alert alert-error">${escapeHtml(opts.orgsError)}</div>`;
  } else {
    const orgs = opts.orgs?.orgs ?? [];
    const rows =
      orgs.length === 0
        ? `<tr><td colspan="4" class="empty-state">No installable organizations.</td></tr>`
        : orgs
            .map((o) => {
              const login = escapeHtml(o.login);
              const lookupAction = !lookupSlug
                ? ""
                : o.lookupAppInstalled
                  ? ""
                  : `<a class="btn btn-secondary" style="font-size:12px;padding:4px 10px" href="https://github.com/apps/${escapeHtml(lookupSlug)}/installations/new" target="_blank" rel="noopener noreferrer">Install lookup app</a>`;
              const agentAction = `<form method="POST" action="${BASE}/orgs/${encodeURIComponent(o.login)}/install" style="display:inline-flex;gap:4px;margin:0">
          <input name="agentId" class="form-input" required placeholder="Agent ID" value="${escapeHtml(agentId)}" style="max-width:160px;padding:4px 8px" />
          <button type="submit" class="btn btn-primary" style="font-size:12px;padding:4px 10px">Install agent app</button>
        </form>`;
              return `<tr>
      <td>${login}</td>
      <td>${installedCell(o.lookupAppInstalled)}</td>
      <td>${installedCell(o.agentAppInstalled)}</td>
      <td style="text-align:right">${lookupAction} ${agentAction}</td>
    </tr>`;
            })
            .join("\n");
    const reason = opts.orgs?.agentAppReason
      ? `<div class="alert alert-error">${escapeHtml(opts.orgs.agentAppReason)}</div>`
      : "";
    body = `${reason}<table class="data-table">
        <thead><tr><th>Organization</th><th>Lookup app</th><th>Agent app</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
  return `<div class="card">
      <div class="card-title">Organizations</div>
      ${filter}
      ${body}
    </div>`;
}

export function renderGithubEnterpriseSettingsPage(
  opts: GithubEnterpriseSettingsPageOpts,
): string {
  const { status } = opts;
  const error = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";
  const notice = opts.notice
    ? `<div class="alert alert-success">${escapeHtml(opts.notice)}</div>`
    : "";
  const intro = `<div class="card">
      <p>Configure an installer app to auto-install agent apps on your enterprise's organizations, and a lookup app for repository access. Both are optional.</p>
      <p class="help-text gh-ent-required" style="margin-top:8px"><strong>A GitHub Enterprise Cloud enterprise is required.</strong> These Apps are created in and scoped to an enterprise.</p>
    </div>`;

  return renderAdminPage({
    title: "GitHub Enterprise — Settings — Shipwright Admin",
    body: `${renderAdminToolbar(opts.userEmail, BASE)}
  <div class="vos-page">
    <div class="page-header"><h1 class="page-title">GitHub Enterprise apps</h1></div>
    ${error}${notice}${intro}
    ${appCard("installer", status.installer, opts.warnings)}
    ${appCard("lookup", status.lookup, opts.warnings)}
    ${orgsCard(opts)}
  </div>`,
  });
}
