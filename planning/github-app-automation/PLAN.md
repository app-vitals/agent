# Plan: github-app-automation — IRM-4 (installation matching fix)

Repo: app-vitals/agent. Continues the `github-app-automation` session (GHE-*, IRM-1..3).

## Problem

The admin Sync card reports "Already in sync" and warns that `GH_APP_ID` is
probably wrong, even when the agent's App is installed and `GH_APP_ID` is
correct. Observed in prod for one agent:

- Its `GH_APP_ID` equals the App's real public id.
- `GET /github-enterprise/orgs?agentId=…` reports `agentAppInstalled: true`
  for the org (matches by slug).
- `GET /agents/{id}/github-installation/repos` returns `orgs: []`
  (matches by numeric id).

## Root cause

`createInstallationPort.installationId()` (`admin/src/installation-ports.ts`)
finds the installation with `listOrgInstallations(org).find(i => i.appId === appId)`.
`toInstallation()` (`admin/src/github-enterprise-client.ts`) fills `appId` from
`app_id`, but GitHub's `enterprise-organization-installation` schema
(`GET /enterprises/{ent}/apps/organizations/{org}/installations`) has no
`app_id`; it returns only `id`, `app_slug`, `client_id` (plus permissions and
timestamps). So `appId` is always `undefined`, nothing matches, and
`AppNotInstalledError` is thrown for every org.

Second defect: `createInstallationReposPort.listInstalled` swallows
`AppNotInstalledError`, so a total miss becomes an empty list, Sync previews
as a no-op and the UI says "Already in sync". The existing tests never caught
either defect because they stub `appId` on the port and no fixture omits
`app_id`.

## Design

**Business logic**
- `InstallationAgentRecord` gains optional `clientId` and `slug`, read from
  the agent env `GH_APP_CLIENT_ID` / `GH_APP_SLUG` (same validation as
  `agentApp()` in `github-enterprise-api.ts`).
- `installationId()` matches in order: `clientId`, then `appSlug`
  (case-insensitive), then `appId` only when GitHub supplied one.
- Port methods keep `appId: number` and gain an optional trailing
  `identity?: { clientId?: string; slug?: string }`. Additive only; exported
  types are consumed by shipwright.
- `AppInstallation.appId` becomes optional, documented as not returned by
  the enterprise endpoint.
- `listInstalled` no longer hides a total miss: when the agent App matches on
  no installer-reachable org it returns an explicit no-installation state.
  Sync preview/apply turn that into `status: "skipped"` with a reason, never
  `noop` / "Already in sync".

**UX**
- Reword `APP_ID_MISMATCH_MESSAGE`: no installation of this agent's App was
  found on any org the installer can reach (matched by client id or slug);
  check the App is installed and the agent has GH_APP_CLIENT_ID / GH_APP_SLUG.
  Stop blaming `GH_APP_ID`.

**API / DB**: no new endpoints, no schema change. The `skipped` reason is the
only response-shape change and is additive.

**Tests**: unit and integration tests for the port and `listInstalled` using a
fixture installation payload with no `app_id` (redacted capture of the real
prod response); a smoke test for the Sync card in the no-match state; retire
tests that assert appId-only matching.

## Decision log

- Match order clientId, then slug, then appId (approved).
- The real enterprise response was captured from prod on 2026-11-12 (run
  inside the admin pod; every installation row on the org lacked `app_id`),
  confirming the root cause. A trimmed copy is embedded in IRM-4.1 and
  committed as `admin/src/fixtures/enterprise-org-installations.json` by that
  task; the implementing agent needs no prod access.
- IRM-2.2 (verify Sync live) gains IRM-4.4 as a dependency instead of a new
  verify task (approved).

## Tasks

| Task | Title | Deps | Layer | Cx / model | Hrs | HITL |
|---|---|---|---|---|---|---|
| IRM-4.1 | fix: match the agent App installation by client id or slug, not the absent app_id | — | API | 4 / sonnet | 4 | |
| IRM-4.2 | fix: report no-installation as skipped instead of in sync and reword the mismatch message | 4.1 | API | 3 / sonnet | 3 | |
| IRM-4.3 | docs: document identity matching and the no-installation state | 4.2 | Shared | 1 / haiku | 1 | |
| IRM-4.4 | chore: wait for the @app-vitals/agent release in shipwright | 4.3 | CLI | 2 / haiku | 1 | |
| IRM-2.2 | (existing) verify Sync live — now also depends on IRM-4.4 | 3.4, 4.4 | CLI | — | — | ⚠ HITL |

```
IRM-4.1 → IRM-4.2 → IRM-4.3 → IRM-4.4 → IRM-2.2
```

All tasks are safe to deploy standalone (additions and a message change only).
