/**
 * admin/src/admin-ui-github-enterprise-pages.ts
 * Render function for the enterprise GitHub apps settings page (GHE-1.4).
 * Pure string -> string; routes live in admin-ui-github-enterprise.ts.
 *
 * Credentials are paste-only: the forms accept the private key but the page
 * never renders a key (the status API only reports `keySet`).
 */

import { renderAdminPage } from "./admin-ui-layout.ts";
import {
  buildSettingsNav,
  renderSettingsLayout,
  type SettingsNav,
} from "./admin-ui-settings-layout.ts";
import { escapeHtml } from "./admin-ui-styles.ts";
import {
  GHE_WARNINGS,
  type GheWarningCode,
} from "./github-enterprise-warnings.ts";

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
  /** Viewer is an admin (drives adminOnly sidebar items). */
  isAdmin?: boolean;
  /** Settings sidebar nav; defaults to the base Platform nav. */
  nav?: SettingsNav;
  status: GheStatus;
  /** Account whose pair is shown; omitted for the deployment-wide pair. */
  accountId?: string;
  /** Accounts offered by the selector; omitted hides it. */
  accounts?: { id: string; name: string }[];
  /** Deployment-wide pair, passed when an account is selected (fallback). */
  defaultStatus?: GheStatus;
  /** Present when the installer App is configured and the org list loaded. */
  orgs?: GheOrgs;
  /** Readable message when the org list could not be loaded. */
  orgsError?: string;
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

/** Lookup setup steps when no installer App exists (per-org manual install). */
function lookupOnlySteps(slug: string | undefined): string[] {
  const link = slug
    ? `https://github.com/apps/${escapeHtml(slug)}/installations/new`
    : "https://github.com/apps/&lt;slug&gt;/installations/new";
  return [
    "In GitHub, open the organization that will own the App: Settings &rarr; Developer settings &rarr; GitHub Apps &rarr; New GitHub App.",
    "Grant Repository <code>Metadata</code> at <strong>Read</strong> and Organization <code>Members</code> at <strong>Read</strong>.",
    "Create the App. The App ID is on the App's settings page; the App slug is the last part of its public URL (<code>github.com/apps/&lt;slug&gt;</code>).",
    `Install it manually on each organization you want covered, choosing <strong>All repositories</strong>: <a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a>. GitHub Enterprise Cloud is not needed.`,
    "Under Private keys, choose Generate a private key and paste the downloaded PEM below.",
  ];
}

const IGNORED_OPTIONS =
  "Ignore these options: callback URL, request user authorization, expire user authorization tokens, device flow, and webhook (uncheck Active).";

function guidance(
  role: "installer" | "lookup",
  lookupOnly: string[] | null,
): string {
  const steps =
    role === "lookup" && lookupOnly ? lookupOnly : ROLE_COPY[role].steps;
  const variant = role === "lookup" && lookupOnly ? " gh-ent-lookup-only" : "";
  return `<ol class="help-text gh-ent-steps${variant}" style="font-size:12px;margin:8px 0;padding-left:20px">${steps.map((x) => `<li>${x}</li>`).join("")}</ol>
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

/** Query suffix carrying the selected account (empty = deployment-wide). */
function scopeQuery(accountId: string | undefined): string {
  return accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
}

function accountSelector(opts: GithubEnterpriseSettingsPageOpts): string {
  if (!opts.accounts) return "";
  const options = [
    `<option value=""${opts.accountId ? "" : " selected"}>Deployment-wide default</option>`,
    ...opts.accounts.map(
      (a) =>
        `<option value="${escapeHtml(a.id)}"${a.id === opts.accountId ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
    ),
  ].join("");
  return `<form method="GET" action="${BASE}" class="gh-ent-account-selector" style="display:flex;gap:8px;align-items:center;margin:8px 0">
        <label>Account <select name="accountId" class="form-input">${options}</select></label>
        <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Switch</button>
      </form>`;
}

/** Which pair the selected account is using: its own row or the fallback. */
function scopeNote(
  role: "installer" | "lookup",
  opts: GithubEnterpriseSettingsPageOpts,
  own: GheApp | null,
): string {
  if (!opts.accountId) return "";
  if (own)
    return `<p class="help-text gh-ent-scope" style="font-size:12px;margin:8px 0"><span class="badge badge-green">Account's own App</span> This account uses its own ${role} App.</p>`;
  const fallback = opts.defaultStatus?.[role];
  return fallback
    ? `<p class="help-text gh-ent-scope" style="font-size:12px;margin:8px 0"><span class="badge badge-gray">Deployment-wide fallback</span> This account has no ${role} App of its own and uses the deployment-wide one (slug <strong>${escapeHtml(fallback.slug)}</strong>). Saving credentials below creates an account-specific App.</p>`
    : `<p class="help-text gh-ent-scope" style="font-size:12px;margin:8px 0"><span class="badge badge-gray">None</span> No ${role} App for this account or deployment-wide.</p>`;
}

function appCard(
  role: "installer" | "lookup",
  app: GheApp | null,
  opts: GithubEnterpriseSettingsPageOpts,
  lookupOnly: string[] | null,
): string {
  const warnings = opts.warnings;
  const copy = ROLE_COPY[role];
  const scope = scopeQuery(opts.accountId);
  const action = `${BASE}/apps/${role}${scope}`;
  const actionFor = (suffix: string) =>
    `${BASE}/apps/${role}/${suffix}${scope}`;
  const summary = app
    ? `<p style="margin:8px 0">App ID <strong>${escapeHtml(app.appId)}</strong> &middot; slug <strong>${escapeHtml(app.slug)}</strong>${app.enterpriseSlug ? ` &middot; enterprise <strong>${escapeHtml(app.enterpriseSlug)}</strong>` : ""}</p>
    ${statusLine(app)}${warningsBlock(role, warnings)}
    <div style="display:flex;gap:8px;margin:12px 0">${postButton(actionFor("validate"), "Validate")}${postButton(actionFor("delete"), "Delete", "btn-danger")}</div>`
    : `<p class="help-text" style="font-size:12px;margin:8px 0">Not configured.</p>`;
  const enterprise =
    role === "installer"
      ? `<label>Enterprise slug <input name="enterpriseSlug" class="form-input" required placeholder="my-enterprise" /></label>`
      : "";
  return `<div class="card">
      <div class="card-title">${copy.title}</div>
      <p class="help-text" style="font-size:12px">${copy.descriptor}</p>
      ${accountSelector(opts)}
      ${scopeNote(role, opts, app)}
      ${guidance(role, lookupOnly)}
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
  if (!(status.installer ?? opts.defaultStatus?.installer)) return "";
  const lookupSlug = (status.lookup ?? opts.defaultStatus?.lookup)?.slug;

  let body: string;
  if (opts.orgsError) {
    body = `<div class="alert alert-error">${escapeHtml(opts.orgsError)}</div>`;
  } else {
    const orgs = opts.orgs?.orgs ?? [];
    const rows =
      orgs.length === 0
        ? `<tr><td colspan="3" class="empty-state">No installable organizations.</td></tr>`
        : orgs
            .map((o) => {
              const lookupAction =
                !lookupSlug || o.lookupAppInstalled
                  ? ""
                  : `<a class="btn btn-secondary" style="font-size:12px;padding:4px 10px" href="https://github.com/apps/${escapeHtml(lookupSlug)}/installations/new" target="_blank" rel="noopener noreferrer">Install lookup app</a>`;
              return `<tr>
      <td>${escapeHtml(o.login)}</td>
      <td>${installedCell(o.lookupAppInstalled)}</td>
      <td style="text-align:right">${lookupAction}</td>
    </tr>`;
            })
            .join("\n");
    body = `<table class="data-table">
        <thead><tr><th>Organization</th><th>Lookup app</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
  return `<div class="card">
      <div class="card-title">Organizations</div>
      ${body}
    </div>`;
}

export function renderGithubEnterpriseSettingsPage(
  opts: GithubEnterpriseSettingsPageOpts,
): string {
  const { status } = opts;
  const effectiveInstaller = status.installer ?? opts.defaultStatus?.installer;
  const effectiveLookup = status.lookup ?? opts.defaultStatus?.lookup;
  const lookupOnly = effectiveInstaller
    ? null
    : lookupOnlySteps(effectiveLookup?.slug);
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
    body: renderSettingsLayout({
      userName: opts.userEmail,
      title: "GitHub Enterprise apps",
      nav:
        opts.nav ??
        buildSettingsNav({ githubEnterprise: true, templates: true }),
      active: BASE,
      isAdmin: opts.isAdmin ?? false,
      body: `${error}${notice}${intro}
    ${appCard("installer", status.installer, opts, lookupOnly)}
    ${appCard("lookup", status.lookup, opts, lookupOnly)}
    ${orgsCard(opts)}`,
    }),
  });
}
