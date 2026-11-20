# GitHub repo lookup: cache and background refresh

Initiative: SWI-12. Raised 2026-11-20.

## Problem

On a deployment with large GitHub organizations, three surfaces call GitHub synchronously and time out with a gateway 502:

1. The agent details page (`GET /admin/agents/:id`) calls `/agents/:id/github-installation/repos` on every render once an agent has a GitHub App. When the agent also has a GitHub username, that call runs the per-repo permission resolver for every repo in every org.
2. The Settings > System crons page calls `GithubLookupService.listRepositories` inline and swallows a failure into an empty listing.
3. The system-cron scheduler tick awaits the same listing before it fires anything.

The lookup is uncached, serial across orgs and pages, and has no timeout. On the affected deployment system crons are not enabled yet because per-repo selection depends on the lookup, so this is a blocker, not just a slow page.

## Goal

No request path and no scheduler tick calls GitHub for repo or access data. A background job keeps a database cache current, backfills missing data first, honors GitHub rate limits, and survives failure and restart. Pages read the cache and say how complete and how fresh it is.

## Requirements

- A DB cache of (a) the repos the lookup App sees per org and (b) the repos each agent App's installation covers, each with per-repo timestamps.
- A background tick, frequent and bounded, separate from the cache TTL. Missing data is always worked before expired data. A staleness cap guarantees a refresh is never starved.
- Resumable crawl: a page cursor with a one-page overlap, a `total_count` completeness check, and a generation sweep that deletes rows not seen only after a complete crawl.
- Access data for agents with a GitHub App and a GitHub username, keyed by (account, org, repo, username). Only definitive answers (including a real "no access") are recorded. Errors stay missing, with attempts, backoff and a terminal state so one bad item never blocks others.
- Rate limits: honor `X-RateLimit-Remaining`/`Reset` and `Retry-After`, record `rateLimitResetAt` per org, and tick more often than the TTL. A per-org lease means the first worker wins and the others skip.
- Manual sync and preview only compute removals from complete data within a freshness bound, or re-verify the specific candidates live.
- A Refresh action that queues the work and returns immediately; a page reload shows progress.
- Debug detail (progress, last error, attempts, rate-limit reset, synced-at) added to the existing repo list, Preview access and System crons views. No new table browser.
- Shipwright: System crons page shows syncing, stale and failed states; the scheduler tick skips accounts that have never synced, uses stale data otherwise, and never rejects the whole tick.

## Constraints

- `@app-vitals/agent-*` exports are additive-only. Platform migrations must pass shipwright's additive-only migration guard (new tables and indexes, no data statements). The platform change ships first, then shipwright picks it up through a release gate.
- The `consumer compat` check does not cover runtime behavior changes with no type change, so the shipwright tasks and the release gate carry that risk.

## Success criteria

- Agent details page and System crons page render without any GitHub call, including with a GitHub username set on an agent in a large org.
- A fresh deployment backfills to completion across ticks without a single request timing out, resuming after rate limits and restarts.
- A repo created in GitHub appears in the cache within the staleness cap; a manual Refresh surfaces it sooner.
- The scheduler tick never fails because of the lookup.

## Priorities and sequence

1. Cache schema and engine (M1), then read paths and UX (M2), then shipwright (M3).
2. The System crons blocker is unblocked by `listRepositories` reading the cache (GLC-2.1) plus the shipwright bump.
3. Do not start shipwright work before the release containing GLC-2.1 is installed there.

## Decisions

- Background refresh for both the lookup App's repos and each agent App's installation repos (decided with Dan, 2026-11-20).
- Per-org priority (missing before expired) in place of a global gate; to be tuned once real timing and failure rates are known.
- Refresh is fire-and-forget; no request waits on GitHub.
