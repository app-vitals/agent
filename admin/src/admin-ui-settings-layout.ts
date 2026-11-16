/**
 * admin/src/admin-ui-settings-layout.ts
 * Shared settings page layout (SGL-1.1): toolbar + left sidebar nav + content
 * pane. Returns body markup — callers wrap it with renderAdminPage.
 * Styles live in baseStyles() between the "Settings layout" markers.
 */

import type { SettingsNavContribution } from "./admin-extension.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";

export interface SettingsNavItem {
  label: string;
  path: string;
  adminOnly?: boolean;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

export interface SettingsNav {
  sections: SettingsNavSection[];
}

export interface RenderSettingsLayoutOptions {
  userName: string;
  /** Raw title; rendered as the escaped H1 of the content pane. */
  title: string;
  nav: SettingsNav;
  /** Path of the active nav item. */
  active: string;
  /** Pre-rendered content markup (caller-owned, not escaped). */
  body: string;
  /** Toolbar active path; defaults to `active`. */
  toolbarPath?: string;
  /** Show adminOnly items. Default false. */
  isAdmin?: boolean;
}

export function renderSettingsLayout(
  opts: RenderSettingsLayoutOptions,
): string {
  const isAdmin = opts.isAdmin ?? false;
  const sections = opts.nav.sections
    .map((s) => ({
      label: s.label,
      items: s.items.filter((i) => isAdmin || !i.adminOnly),
    }))
    .filter((s) => s.items.length > 0);

  const link = (i: SettingsNavItem): string => {
    const current = i.path === opts.active;
    return `<a class="settings-nav-link" href="${escapeHtml(i.path)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(i.label)}</a>`;
  };
  const sectionsHtml = sections
    .map(
      (s) =>
        `<div class="settings-nav-section"><div class="settings-nav-label">${escapeHtml(s.label)}</div>${s.items.map(link).join("")}</div>`,
    )
    .join("");

  const activeLabel =
    sections.flatMap((s) => s.items).find((i) => i.path === opts.active)
      ?.label ?? opts.title;

  return `${renderAdminToolbar(opts.userName, opts.toolbarPath ?? opts.active)}
<div class="vos-page vos-page-wide vos-page-settings">
  <div class="settings-layout">
    <nav class="settings-sidebar" aria-label="Settings">${sectionsHtml}</nav>
    <details class="settings-nav-mobile"><summary>${escapeHtml(activeLabel)}</summary>${sectionsHtml}</details>
    <main class="settings-content">
      <h1>${escapeHtml(opts.title)}</h1>
      ${opts.body}
    </main>
  </div>
</div>`;
}

/**
 * Appends contributed items into the section with the matching label (an
 * unknown section is appended at the end). Pure: the input nav is not mutated.
 */
export function mergeSettingsNavItems(
  nav: SettingsNav,
  items: SettingsNavContribution[],
): SettingsNav {
  const sections: SettingsNavSection[] = nav.sections.map((s) => ({
    label: s.label,
    items: [...s.items],
  }));
  for (const { section, ...item } of items) {
    let target = sections.find((s) => s.label === section);
    if (!target) {
      target = { label: section, items: [] };
      sections.push(target);
    }
    target.items.push(item);
  }
  return { sections };
}

export const SETTINGS_GHE_PATH = "/admin/settings/github-enterprise";
export const SETTINGS_ACCOUNT_PATH = "/admin/account";
export const SETTINGS_ACCOUNTS_PATH = "/admin/accounts";
export const SETTINGS_TEMPLATES_PATH = "/admin/settings/templates";

export interface BuildSettingsNavOptions {
  /** Include the GitHub Enterprise item (its routes are registered). */
  githubEnterprise?: boolean;
  /** Include Account (members) and, admin-only, Accounts (SGL-2.3). */
  accounts?: boolean;
  /** Include the Templates item (its routes are registered). */
  templates?: boolean;
  /** Extension-contributed items (SGL-2.1). */
  extraItems?: readonly SettingsNavContribution[];
}

/**
 * Base settings nav: Account section (SGL-2.3), Platform section (GitHub
 * Enterprise, Templates, admin-only Accounts) plus extension items. Empty
 * sections are dropped.
 */
export function buildSettingsNav(
  opts: BuildSettingsNavOptions = {},
): SettingsNav {
  const platform: SettingsNavItem[] = [];
  if (opts.githubEnterprise) {
    platform.push({
      label: "GitHub Enterprise",
      path: SETTINGS_GHE_PATH,
      adminOnly: true,
    });
  }
  if (opts.templates) {
    platform.push({ label: "Templates", path: SETTINGS_TEMPLATES_PATH });
  }
  if (opts.accounts) {
    platform.push({
      label: "Accounts",
      path: SETTINGS_ACCOUNTS_PATH,
      adminOnly: true,
    });
  }
  const sections: SettingsNavSection[] = [];
  if (opts.accounts) {
    sections.push({
      label: "Account",
      items: [{ label: "Account", path: SETTINGS_ACCOUNT_PATH }],
    });
  }
  if (platform.length > 0)
    sections.push({ label: "Platform", items: platform });
  const base: SettingsNav = { sections };
  return mergeSettingsNavItems(base, [...(opts.extraItems ?? [])]);
}

/** First nav item visible to the viewer, or undefined. */
export function firstVisibleSettingsItem(
  nav: SettingsNav,
  isAdmin: boolean,
): SettingsNavItem | undefined {
  return nav.sections
    .flatMap((s) => s.items)
    .find((i) => isAdmin || !i.adminOnly);
}
