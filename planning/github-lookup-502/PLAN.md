# Plan: github-lookup-502

Home repo: `app-vitals/agent`. Targets: `app-vitals/agent`, `app-vitals/shipwright`. Initiative: SWI-12. Spec: `PRODUCT-SPEC.md`.

## Pass 1 — 2026-11-20 — specs 1

### Technical design

**Root cause (from code).** `GithubLookupService.listRepositories` (`admin/src/github-lookup-repositories.ts`) is uncached and serial: for each installable org it mints a token and pages `/installation/repositories` at 100 per page. `GET /admin/agents/:id` (`admin/src/admin-ui.ts`) calls `/agents/:id/github-installation/repos` inline. With a GitHub username set, `InstallationReposService.list` also runs `UserRepoAccessResolver.resolve`, one collaborator-permission call per repo at concurrency 5. Shipwright's System crons page (`admin/src/coding/admin-ui-system-crons.ts`) and scheduler (`admin/src/coding/system-cron-scheduler.ts`) call the same lister, the page swallowing failures to null and the tick rejecting.

**Shape.** A sweeper-style refresher (setInterval in `admin-boot.ts`, the existing sweeper pattern) fills a DB cache. Every read path reads the cache and never calls GitHub.

- **Tables (additive).** Per-org snapshot keyed by (accountId, appKind lookup|agent, appRef, org) with crawl cursor and debug columns; cached repos with a per-repo `seenAt`; access rows keyed by (account, org, repo, username).
- **Crawl.** `/installation/repositories` supports only `page` and `per_page`, documents no ordering and returns `total_count`. So the crawl uses a page-number cursor resumed one page back, writes each page as it lands, marks the list complete only when rows seen equal `total_count`, and deletes rows not seen this crawl only after a complete pass. Missing repos matter more than stale ones, so partial lists are served immediately.
- **Access backfill.** Per (user, repo) permission checks, only definitive answers recorded, errors stay missing with attempts, capped backoff and a terminal state. Keyed by username so agents sharing a user share rows. The TTL is the cursor: the work list is pairs with no row or an expired row.
- **Priority.** Per org, missing work before expired work, plus a staleness cap so a refresh is never starved. Ticks are frequent (about a minute) and bounded by a time budget; the TTL is separate (hourly by default). Rate limits set `rateLimitResetAt` and the org is skipped until then. A per-org lease means the first worker wins.
- **Read paths.** `listRepositories` keeps its signature and gains optional `syncState`, `fetchedAt` and progress. The agent page and System crons show "N of M", synced-at and errors. Manual sync computes removals only from complete, fresh data and re-verifies each candidate live.
- **Refresh.** Fire-and-forget: mark stale, return immediately, reload to see progress.
- **Shipwright.** After the release gate, the System crons page shows explicit syncing/stale/failed states and the scheduler skips only unsynced accounts.

**Compatibility.** `consumer compat` (admin-gen, typecheck, seed-dev-agent, migration-guard) constrains the work: the migration must pass shipwright's additive-only guard, new fields must be optional, and new route copy must pass the banned-strings scan. It does not cover runtime behavior changes with no type change, so GLC-2.1's semantics are covered by its own tests and by GLC-3.2/3.3. Old shipwright on the new platform degrades to an empty list with `syncState: syncing`, not a 502, so the bump alone unblocks System crons.

**Risks accepted.** First backfill of a very large org takes several ticks (UI shows progress). Page-number resume can skip a repo if one is removed mid-crawl; the `total_count` check catches it and restarts. GitHub's ordering is undocumented and never relied on.

### Tasks

| Task | Repo | Title | Depends on | Model | HITL |
|---|---|---|---|---|---|
| GLC-1.1 | agent | feat: add GitHub repo cache schema and service | — | sonnet | |
| GLC-1.2 | agent | feat: resumable GitHub repo crawler with rate-limit awareness | 1.1 | opus | |
| GLC-1.3 | agent | feat: backfill per-user repo access with TTL, backoff and terminal state | 1.1, 1.2 | sonnet | |
| GLC-1.4 | agent | feat: per-org refresh tick with priorities, lease and time budget | 1.2, 1.3 | opus | |
| GLC-1.5 | agent | feat: crawl each agent App's installation repos into the cache | 1.2 | sonnet | |
| GLC-2.1 | agent | feat: serve listRepositories from the cache | 1.2 | sonnet | |
| GLC-2.2 | agent | feat: agent page reads the installation cache and shows sync detail | 1.3, 1.5 | sonnet | |
| GLC-2.3 | agent | feat: gate manual sync and preview on complete, fresh cache | 1.3, 2.2 | sonnet | |
| GLC-2.4 | agent | feat: fire-and-forget Refresh action | 1.4 | sonnet | |
| GLC-2.5 | agent | feat: show cache debug detail in existing repo views | 1.4 | sonnet | |
| GLC-3.1 | shipwright | chore: wait for the @app-vitals/agent release carrying GLC-2.1 and GLC-2.2 in shipwright | 2.1, 2.2 | haiku | |
| GLC-3.2 | shipwright | feat: show syncing, stale and failed states on the System crons page | 3.1 | sonnet | |
| GLC-3.3 | shipwright | fix: scheduler tick tolerates an unsynced or stale lookup | 3.1 | sonnet | |

### Dependency map

```
[START]
  └─ GLC-1.1 schema
        └─ GLC-1.2 crawler
              ├─ GLC-1.3 access backfill ──┐
              ├─ GLC-1.5 agent-install crawl ─┤
              ├─ GLC-2.1 listRepositories from cache ──┐
              │                                          │
              └─ (1.2 + 1.3) GLC-1.4 refresh tick        │
                    ├─ GLC-2.4 Refresh action            │
                    └─ GLC-2.5 debug detail              │
        GLC-1.3 + GLC-1.5 ─ GLC-2.2 agent page ─ GLC-2.3 sync gate
        GLC-2.1 + GLC-2.2 ─ GLC-3.1 release gate (shipwright; derives the version from those two tasks)
              ├─ GLC-3.2 System crons states
              └─ GLC-3.3 scheduler tolerance
```

### Breaking change safety

Everything on the platform side is additive: new tables, new optional return fields, a new route, a new sweeper. GLC-2.1 changes runtime behavior of `listRepositories` with no type change; the old shipwright code tolerates it (empty list, `syncState: syncing`) so there is no broken intermediate state. GLC-3.2 and GLC-3.3 follow a release gate. No renames or removals of exports. The live-walk tests in GLC-2.1 and the live-resolver assertions in GLC-2.2/2.3 are retired because the code they exercise moves behind the cache.

### Not carried

- "Enable system crons for chosen repos on the client" is a deployment action by Dan after the shipwright bump; no task performs it. The release gate (GLC-3.1) is the last repo-side step.

### Decision log

- Background refresh for both lookup and agent-installation data: decided with Dan, 2026-11-20.
- Per-org priority (missing before expired) with a staleness cap, instead of a strict global gate: decided with Dan; to be tuned once real timing and failure rates are known.
- Per-org DB lease (corrects an earlier no-lease default): rate budget is the scarce resource.
- Refresh is fire-and-forget; debug detail goes into existing views, no new table browser or status page: decided with Dan.
- Interim "skip inline lookup" flag not planned: not requested.
- Owner left empty: the initiative carried no owner.
- Release gate GLC-3.1 names its producer tasks (GLC-2.1, GLC-2.2) and derives the version from their merge commits at completion time, instead of a hard-coded minimum version: decided with Dan, 2026-11-20.
