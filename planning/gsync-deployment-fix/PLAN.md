# Plan: gsync-deployment-fix

Fix GitHub Sync "access data is incomplete" for deployment-wide (null-account) agents, make skip causes visible, fix misleading Sync messages, and show installation sync timestamps in Pacific time.

Repo: `app-vitals/agent` (GSF-3.2 is in `app-vitals/vitals-os`).

## Background

Observed on prod, agent `cmwtlylyg0eo301c6afsxpcfn`, org `ok-wow`: Sync preview returned `appAdds: []` and `skippedOrgs: [{org: "ok-wow", reason: "access data is incomplete"}]`, while the cache was healthy (lookup crawl for app 5705622 complete with 31 repos, 31 `ok` access rows for the bound user, no errors or rate limit) and the live `GET /agents/{id}/github-access` returned all 31 repos pushable.

Root cause: `lookupRepos` in `admin/src/github-installation-wiring.ts` queries lookup snapshots with `accountId ? [accountId, ""] : [""]`, but the crawler files deployment-wide snapshots under `DEPLOYMENT_WIDE_ACCOUNT_KEY = "deployment"` (`admin/src/github-agent-installation-crawler.ts`). Every other call site uses `agent.accountId || DEPLOYMENT_WIDE_ACCOUNT_KEY`. For a null-account agent the lookup returns nothing, `cachedAccess` (`github-sync.ts`) sets `crawlMissing`, and `buildCachedAccess` (`github-sync-cached-access.ts`) reports the org as incomplete.

Expected after the fix: preview shows 30 `appAdds` for `ok-wow` (31 pushable minus `ok-wow-infra`, already installed), applied as a single `PATCH .../repositories/add` (batches of at most 50).

## Design

- **Business logic.** `lookupRepos` queries `[accountId, DEPLOYMENT_WIDE_ACCOUNT_KEY]` (account set) or `[DEPLOYMENT_WIDE_ACCOUNT_KEY]` (null account). `""` is dropped: nothing writes under it. A real account literally named `"deployment"` would collide with the fallback key; noted, not fixed.
- **Visibility.** `skippedOrgs` entries gain an optional `detail`: lookup snapshot found or not, its `completedAt`, `lastError`, `rateLimitResetAt`, total repos, repos with an `ok` access row, repos missing an answer, error and terminal counts, and the oldest-checked time for stale data. `CachedLookupOrg` carries `lastError` and `rateLimitResetAt`; access-row detail from `getAccessRows` flows through `CachedOrgInput` and `buildCachedAccess`. The existing `reason` strings are unchanged. OpenAPI and `lib/admin-types.ts` are regenerated. All additive.
- **UI.** `skippedOrgsHtml` renders `detail` as readable text. The "Already in sync: nothing to add or remove." success alert is shown only when no org was skipped; otherwise a warning says nothing was synced and how many orgs were skipped. The `warnings` entry that duplicates `skippedOrgs` is no longer rendered (the API keeps it for compatibility).
- **Timestamps.** `renderInstallationSyncStatus` hardcodes `... UTC`. The admin UI already has a `timezone` option fed by `SHIPWRIGHT_ADMIN_TZ` (unset in prod, so UTC). Format with `Intl` using that option. API JSON and `reason` strings stay UTC ISO (machine-read); the UI formats the structured `detail` timestamps. Pacific comes from setting `SHIPWRIGHT_ADMIN_TZ=America/Los_Angeles` in prod values, not from a new code default.

## Tasks

| Task | Title | Layer | Depends on | Model | Hours |
|---|---|---|---|---|---|
| GSF-1.1 | fix: use the deployment-wide account key when reading lookup snapshots | Background | none | haiku | 1 |
| GSF-2.1 | feat: add per-org detail to skippedOrgs in sync preview and apply | API | none | sonnet | 3 |
| GSF-2.2 | feat: render skipped-org detail in the Sync card | Frontend | GSF-2.1 | sonnet | 2 |
| GSF-2.3 | fix: stop showing "already in sync" when orgs were skipped | Frontend | GSF-2.2 | sonnet | 1 |
| GSF-3.1 | feat: show installation sync timestamps in the admin timezone | Frontend | GSF-2.2 | haiku | 2 |
| GSF-3.2 | chore: set SHIPWRIGHT_ADMIN_TZ for the admin deployment (app-vitals/vitals-os) | Shared | none | haiku | 1 |

GSF-2.1, 2.2 and 2.3 share branch `feat/gsf-skip-detail` (one PR) and inherit `sonnet`.

```
[START]
  ├─ GSF-1.1 (no deps)  ← ships first, unblocks the ok-wow test
  ├─ GSF-3.2 (no deps, other repo)
  └─ GSF-2.1 (no deps)
        └─ GSF-2.2 (needs 2.1)
              ├─ GSF-2.3 (needs 2.2, same branch)
              └─ GSF-3.1 (needs 2.2)
```

## Breaking Change Safety

All changes are additive (optional `detail`, optional fields on exported types) or internal. No renames or removals. The `reason` strings are deliberately untouched so `shipwright` and existing tests matching them do not break. Every task: safe to deploy standalone: yes.

## Post-deploy check (human)

After GSF-1.1 is released and deployed: `GET /agents/cmwtlylyg0eo301c6afsxpcfn/github-sync/preview` should list 30 `appAdds` for `ok-wow` with no skipped orgs. Then press Sync.
