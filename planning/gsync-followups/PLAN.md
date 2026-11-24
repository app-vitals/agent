# Plan: gsync-followups

Follow-up to `gsync-deployment-fix`. Repo: `app-vitals/agent`.

## Scope

1. **Dropped: transient GitHub failures counting as skips.** Reviewed and deliberately not changed. A review dispatch that cannot reach GitHub ends `[silent]`; the orchestrator records it as `command:no-work`, and three skips block the item. The block surfaced a real failure to a human, which is the desired outcome. Recorded so it is not rediscovered:
   - The blocked reason reads "dispatched but found nothing to do", which is misleading for a network failure. Wording only; no task.
   - `Task` skips are reason-aware (the same reason repeating counts, any other resets). `PullRequest` skips are a plain count with no reason, so any three skips block.
   - A runner crash also records a stable `dispatch:runner-error` reason and counts.
2. **GFU-1.1** end-to-end cache round-trip test.
3. **GFU-2.x** lookup-only (no installer App) behavior and messaging.

## Findings (read from the code)

What works with only the lookup App (no installer):

| Capability | Lookup-only |
|---|---|
| Repo crawl and cache (refresher; discovery falls back to `lookup.listInstallations()` when no installer has an enterprise slug) | works |
| System-crons repo lister and picker (`createGithubLookupService` needs the installer key only when the installer has an enterprise slug) | works |
| Live access preview, `GET /agents/{id}/github-access` (`createGithubAccessPreview` returns `unconfigured` unless the installer is set) | **no** |
| Sync preview and apply, installation repos list | no (enterprise-only endpoint) |
| Install-on-org block | no (enterprise-only endpoint) |

The access resolver uses the installer only for `listInstallableOrganizations()`. A lookup-only org source (`lookup.listInstallations()`) is feasible and additive. No consumer in `app-vitals/shipwright` calls the access endpoint (documentation mentions only), so no producer/consumer split or release gate is needed.

## Design

- **Business logic.** Give `UserRepoAccessResolver` an org source: the installer's `listInstallableOrganizations()` when an installer is configured, else the lookup App's `listInstallations()`. `createGithubAccessPreview` returns `unconfigured` only when the lookup App is missing. All new members optional; `GithubAccessPreviewFn` unchanged.
- **UI/API messaging.** Replace the single "installer not configured" warning with two explicit states: lookup-only ("repo access is visible; Sync and installation repos need an enterprise installer App") and both configured (today's behavior). Separate "lookup missing" from "installer missing" in every message.
- **Test.** Real-Postgres integration test (the existing `DATABASE_URL_ADMIN_TEST` pattern, which CI sets) rather than `fakePrisma`, because a fake that re-implements the `accountId` filter can repeat the same mistake. Real refresher/crawler writes; every reader reads back.

## Tasks

| Task | Title | Repo | Layer | Depends on | Model | Hours |
|---|---|---|---|---|---|---|
| GFU-1.1 | test: add a real-database round trip for the GitHub repo cache | agent | Background | none | sonnet | 3 |
| GFU-2.1 | feat: resolve GitHub access with only the lookup App | agent | API | none | sonnet | 3 |
| GFU-2.2 | feat: explain lookup-only limits on every installer-dependent surface | agent | Frontend | GFU-2.1 | sonnet | 3 |
| GFU-2.3 | docs: document lookup-only GitHub App capabilities | agent | Shared | GFU-2.2 | haiku | 1 |

GFU-2.1 and GFU-2.2 share branch `feat/gfu-lookup-only` (one PR) and inherit `sonnet`.

```
[START]
  ├─ GFU-1.1 (no deps)
  └─ GFU-2.1 (no deps)
        └─ GFU-2.2 (needs 2.1, same branch)
              └─ GFU-2.3 (needs 2.2)
```

## Sibling-site scan (installer-dependent surfaces)

Each site below is a deliverable of GFU-2.2 (the PR lists every site it checked) unless marked checked-fine.

| Site | Behavior today | Disposition |
|---|---|---|
| `github-enterprise-api.ts` `createGithubAccessPreview` | `unconfigured` unless installer + enterprise slug | GFU-2.1 |
| `agents-api.ts` `GET /agents/{id}/github-access` | 503/`unconfigured` text covers both Apps | GFU-2.1 (OpenAPI text), GFU-2.2 (reason) |
| `admin-ui.ts` `githubEnterpriseConfigured` | requires both Apps | GFU-2.2 (two states) |
| `admin-ui-github-identity-pages.ts` (`renderGithubAccessResult`, `renderGithubOrgsFragment`) | generic "apps not configured" / "installer not configured" | GFU-2.2 |
| `admin-ui-installation-repos-pages.ts` (`INSTALLER_UNCONFIGURED_REASON`) | generic warning | GFU-2.2 |
| `github-sync.ts` / `installation-repos-service.ts` preview, apply, list | skipped / empty with generic reasons | GFU-2.2 |
| `github-enterprise-api.ts` `createGithubLookupService` (system-crons) | works lookup-only | checked, fine |
| `github-repo-refresh-discovery.ts` (crawl) | falls back to lookup installations | checked, fine |

## Breaking Change Safety

All changes are additive or internal. No renames or removals; no exported type gains a required member. Every task: safe to deploy standalone: yes.

## Decision Log

- Scope of item 3: added GFU-2.1 (lookup-only access preview), because the requested message ("repo access is visible") is not true without it.
- Docs location: `docs/platform/` in this repo is the source; GFU-2.3 checks whether the copy in `app-vitals/shipwright` is auto-synced and reports if a mirror update is needed.
- Out of scope: the `"deployment"` account-key collision with a real account of that name, the cause of the bad node, and users re-selecting system-cron repos.
