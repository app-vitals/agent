# Settings redesign — Plan

**Session**: settings-redesign
**Repos**: app-vitals/agent (SGL-1.x, 2.x), app-vitals/shipwright (SGL-3.x)
**Supersedes**: the accordion agent detail page (AGA-1.1 to 1.3, `agent-landing-page-redesign`).

## Goal

Redesign the agent detail page and the admin settings pages around a GitHub-style
settings shell: a left sidebar of grouped sections, and one page per view on the right.
GitHub is the structural inspiration only. The pages keep Shipwright's look (navy
`#1a1a2e`, indigo `#4f46e5` accent, `#eef2ff` active pill, `#e8e8ee` borders, `#f7f7fb`
page background, existing `.card` / `.btn` / `.form-input` / `.alert` classes) so the agent
and Shipwright surfaces read as one product.

## Design

**Shared shell.** `renderSettingsLayout({ title, nav, active, body })` in
`admin/src/admin-ui-settings-layout.ts`. It renders the existing toolbar, a ~260px sidebar
(grey section labels, dividers, active item as an indigo pill matching `.vos-nav-link.active`),
and a content pane (H1 plus divider, H2 subsections with dividers, `.card` boxes, a red-bordered
danger box). Styles live in `baseStyles()` and are used by every settings-style page. No icons,
no chevrons, no context switcher. Below the mobile breakpoint the sidebar collapses into a
`<details>` dropdown.

**Agent pages.** One page per section at `/admin/agents/:id/<section>`; `/admin/agents/:id`
stays as General. The existing single data loader stays; only the active section renders.
- General: header info, stat strip, extension "header" cards, Danger zone at the bottom.
- Automation: cron jobs.
- Configuration: env vars, repos, policy, extension "configuration" cards.
- Access: identity, members, author allowlists, Slack access, tokens.
- Extensions: tools, plugins, marketplaces.

The ~51 POST handlers that redirect to `/admin/agents/:id` get an `agentSectionPath()` helper so
each lands back on its own section (with its `?error=` / `?success=` params). The accordion
(`.group*` CSS, expand/collapse controls) is removed.

**Admin settings.** Same shell. Sidebar sections: Platform (GitHub Enterprise, Templates,
System crons, Accounts admin-only), Account (members and invites), Personal (Notifications).
Existing URLs (`/admin/account`, `/admin/accounts`, `/admin/settings/*`) and their POST routes
are kept; only the rendering changes. The top-nav Account link is removed; "Settings" shows for
admins and account members and lands on the first item they can see.

**Extension hook.** `AdminExtension.settingsNavItems()` returns `{section, label, path,
adminOnly?}`; `renderSettingsLayout` is exported from `server.ts`. Both additive.
Shipwright registers System crons and Notifications through it.

## Breaking Change Safety

All agent-package changes are additive (new export, new optional hook, new routes). Existing
URLs are kept. The only removals are the accordion markup/CSS and the top-nav Account link, both
internal to the agent admin package and replaced in the same task. Shipwright consumes the new
export only after the release gate.

## Tasks

| ID | Repo | Task | Depends on |
|---|---|---|---|
| SGL-1.1 | agent | feat: shared settings layout and sidebar styles | — |
| SGL-1.2 | agent | feat: agent section routes with General, Automation, Configuration (bundle A) | 1.1 |
| SGL-1.3 | agent | feat: agent Access and Extensions sections, section redirects, remove accordion (bundle A) | 1.2 |
| SGL-2.1 | agent | feat: settingsNavItems extension hook and layout export | 1.1 |
| SGL-2.2 | agent | feat: settings shell, GHE and Templates on layout, role-aware toolbar entry | 2.1 |
| SGL-2.3 | agent | feat: Account and Accounts pages in the settings shell | 2.2 |
| SGL-2.4 | agent | test: e2e for settings nav and per-section agent pages | 1.3, 2.3 |
| SGL-3.1 | shipwright | chore: wait for @app-vitals/agent-admin release with settings shell | 2.3, 2.4 |
| SGL-3.2 | shipwright | feat: register System crons and Notifications in the settings shell | 3.1 |

## Decision Log

- Account/Accounts URLs: kept as-is, re-rendered inside the shell (Dan, simplicity).
- Danger zone: bottom of General (Dan).
- Shipwright agent cards: stay on General and Configuration, no new placement (Dan).
- Styling: GitHub structure with Shipwright tokens, so agent and Shipwright pages stay cohesive (Dan).
- One page per view, separate URLs (Dan).
