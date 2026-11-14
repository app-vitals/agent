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
<div class="vos-page">
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
