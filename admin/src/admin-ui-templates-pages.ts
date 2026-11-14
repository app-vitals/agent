/**
 * admin/src/admin-ui-templates-pages.ts
 * Render function for the Settings > Templates editor (ATP-2.3).
 * Pure string -> string; routes live in admin-ui-templates.ts.
 *
 * Secret env values arrive already masked ("***") from the template service;
 * the page only ever echoes what it is given, and posting the mask back keeps
 * the stored secret.
 */

import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";

export const ADMIN_TEMPLATES_PATH = "/admin/settings/templates";

const BASE = ADMIN_TEMPLATES_PATH;

export interface TemplateScopeOption {
  value: string;
  label: string;
}

export interface TemplateItemRow {
  kind: "env" | "tool" | "plugin" | "cron";
  key: string;
  payload: Record<string, unknown>;
}

export interface TemplatesPageOpts {
  userEmail: string;
  /** Accounts the caller may pick; the deployment-wide option is included only for admins. */
  accountOptions: TemplateScopeOption[];
  specialtyOptions: TemplateScopeOption[];
  /** Selected scope ("" = deployment-wide / all types). */
  accountId: string;
  specialty: string;
  /** Items of the template at the selected scope (empty when none exists yet). */
  items: TemplateItemRow[];
  templateExists: boolean;
  error?: string;
  notice?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function options(opts: TemplateScopeOption[], selected: string): string {
  return opts
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");
}

function scopePicker(o: TemplatesPageOpts): string {
  return `<form method="GET" action="${BASE}" class="template-scope" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <label>Account <select name="accountId" class="form-input">${options(o.accountOptions, o.accountId)}</select></label>
      <label>Agent type <select name="specialty" class="form-input">${options(o.specialtyOptions, o.specialty)}</select></label>
      <button type="submit" class="btn btn-secondary">Open template</button>
    </form>`;
}

function scopeFields(o: TemplatesPageOpts): string {
  return `<input type="hidden" name="accountId" value="${escapeHtml(o.accountId)}" /><input type="hidden" name="specialty" value="${escapeHtml(o.specialty)}" />`;
}

const checked = (b: unknown, dflt = true) =>
  (b === undefined ? dflt : b !== false) ? " checked" : "";

/** The editable fields of one item (shared by the existing-item and add forms). */
function itemFields(
  kind: TemplateItemRow["kind"],
  p: Record<string, unknown>,
): string {
  switch (kind) {
    case "env":
      return `<label>Value <input name="value" class="form-input" autocomplete="off" value="${escapeHtml(str(p.value))}"/></label>
        <label><input type="checkbox" name="secret" value="1"${p.secret === true ? " checked" : ""} /> Secret</label>`;
    case "tool":
      return `<label><input type="checkbox" name="enabled" value="1"${checked(p.enabled)} /> Enabled</label>`;
    case "plugin":
      return `<label>Version <input name="version" class="form-input" value="${escapeHtml(str(p.version))}" placeholder="latest" /></label>
        <label><input type="checkbox" name="enabled" value="1"${checked(p.enabled)} /> Enabled</label>`;
    case "cron":
      return `<label>Schedule <input name="schedule" class="form-input" value="${escapeHtml(str(p.schedule))}" placeholder="0 9 * * 1-5" /></label>
        <label>Prompt <textarea name="prompt" class="form-input" rows="2">${escapeHtml(str(p.prompt))}</textarea></label>
        <label>Channel <input name="channel" class="form-input" value="${escapeHtml(str(p.channel))}" /></label>
        <label>User <input name="user" class="form-input" value="${escapeHtml(str(p.user))}" /></label>
        <label>Pre-check <input name="preCheck" class="form-input" value="${escapeHtml(str(p.preCheck))}" /></label>
        <label><input type="checkbox" name="silent" value="1"${p.silent === true ? " checked" : ""} /> Silent</label>
        <label><input type="checkbox" name="enabled" value="1"${checked(p.enabled)} /> Enabled</label>`;
  }
}

const KIND_COPY = {
  env: { title: "Environment variables", key: "Name", ph: "MY_SETTING" },
  tool: { title: "Tools", key: "Tool pattern", ph: "Bash(git *)" },
  plugin: { title: "Plugins", key: "Plugin", ph: "shipwright@shipwright" },
  cron: { title: "Crons", key: "Name", ph: "daily-digest" },
} as const;

function kindCard(o: TemplatesPageOpts, kind: TemplateItemRow["kind"]): string {
  const copy = KIND_COPY[kind];
  const rows = o.items
    .filter((i) => i.kind === kind)
    .map(
      (
        i,
      ) => `<form method="POST" action="${BASE}/items" class="template-item" data-kind="${kind}" data-key="${escapeHtml(i.key)}" style="display:grid;gap:6px;padding:8px 0;border-bottom:1px solid #e5e7eb">
        ${scopeFields(o)}<input type="hidden" name="kind" value="${kind}" /><input type="hidden" name="key" value="${escapeHtml(i.key)}" />
        <strong>${escapeHtml(i.key)}</strong>
        ${itemFields(kind, i.payload)}
        <div style="display:flex;gap:8px"><button type="submit" class="btn btn-primary" style="font-size:12px;padding:4px 10px">Save</button>
        <button type="submit" formaction="${BASE}/items/delete" class="btn btn-danger" style="font-size:12px;padding:4px 10px">Remove</button></div>
      </form>`,
    )
    .join("");
  const empty = rows ? "" : `<p class="help-text empty-state">None yet.</p>`;
  return `<div class="card" id="template-${kind}">
      <div class="card-title">${copy.title}</div>
      ${rows}${empty}
      <form method="POST" action="${BASE}/items" class="template-add" style="display:grid;gap:6px;margin-top:12px;max-width:480px">
        ${scopeFields(o)}<input type="hidden" name="kind" value="${kind}" />
        <label>${copy.key} <input name="key" class="form-input" required placeholder="${escapeHtml(copy.ph)}" /></label>
        ${itemFields(kind, {})}
        <div><button type="submit" class="btn btn-primary">Add ${kind}</button></div>
      </form>
    </div>`;
}

export function renderTemplatesPage(o: TemplatesPageOpts): string {
  const error = o.error
    ? `<div class="alert alert-error">${escapeHtml(o.error)}</div>`
    : "";
  const notice = o.notice
    ? `<div class="alert alert-success">${escapeHtml(o.notice)}</div>`
    : "";
  const del = o.templateExists
    ? `<form method="POST" action="${BASE}/delete" style="margin:8px 0">${scopeFields(o)}<button type="submit" class="btn btn-danger">Delete this template</button></form>`
    : `<p class="help-text">No template exists for this scope yet. Adding an item creates it.</p>`;
  return renderAdminPage({
    title: "Templates — Settings — Shipwright Admin",
    body: `${renderAdminToolbar(o.userEmail, BASE)}
  <div class="vos-page">
    <div class="page-header"><h1 class="page-title">Agent templates</h1></div>
    ${error}${notice}
    <div class="card">
      <p class="help-text">Default env vars, tools, plugins and crons for new agents in a scope. Secret values are masked after saving; leave <code>***</code> to keep the stored value.</p>
      ${scopePicker(o)}
      ${del}
    </div>
    ${(["env", "tool", "plugin", "cron"] as const).map((k) => kindCard(o, k)).join("\n")}
  </div>`,
  });
}
