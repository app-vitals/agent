# Plan: settings-full-width

Repo: app-vitals/agent (consumer follow-up in app-vitals/shipwright)

## Problem
`.vos-page` is `max-width: 960px` (`lib/web/toolbar.ts:118`). `renderSettingsLayout`
(`admin/src/admin-ui-settings-layout.ts:68`) wraps every settings page in it (agent detail,
account, accounts, templates, github-enterprise). With the 260px sidebar the content pane is ~620px.

## Design
- `lib/web/toolbar.ts`: add general `.vos-page-wide { max-width:none; width:100% }` (after `.vos-page`, equal specificity wins).
- `renderSettingsLayout` emits `class="vos-page vos-page-wide vos-page-settings"`.
- `baseStyles()` settings block: cap `.settings-content .form-input` and text-like inputs at `max-width: 640px` so forms don't stretch; tables/cards use full width. Mobile/tablet padding rules untouched.
- No 1600px cap: `.settings-content` already flexes.
- Shipwright: once released, replace `.admin-wide-page` with `.vos-page-wide` and delete `admin/src/coding/admin-wide-page.ts`.

## Tasks
| Task | Title | Depends on | Model |
|---|---|---|---|
| SFW-1.1 | feat: make settings layout full-width | — | haiku |
| SFW-2.1 | chore: wait for @app-vitals/agent >= 1.52.0 in shipwright | SFW-1.1 | haiku |
| SFW-2.2 | refactor: replace admin-wide-page with agent-lib vos-page-wide | SFW-2.1 | haiku |

Dependency map: SFW-1.1 → SFW-2.1 → SFW-2.2

Breaking change safety: all additive in agent; shipwright override stays until the bump lands. Safe to deploy standalone: yes.

## Notes
- Input cap of 640px is a judgment call; tune freely.
- Gate min version 1.52.0 assumes SFW-1.1 releases as the next minor after the current 1.51.0 pin; verify against the actual release.
