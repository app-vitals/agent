# Plan: gh-install-selection

Session `gh-install-selection` — repo `app-vitals/agent`. Fixes the agent GitHub App install flow so GitHub Sync works whichever repository selection the operator picks on GitHub's install page, and adds uninstall from an org.

## Pass 1 — 2026-11-25 — no registered spec (planned from a verbal description)

### Problem

The provision flow ends on a link to `github.com/apps/<slug>/installations/new`, where the operator picks **All repositories** or **Only select repositories**. GitHub Sync only manipulates an installation through the add and remove repository endpoints, and those apply to "selected" installations. On an "all" installation the installation's repo list is every org repo, so Sync computes removes that cannot be applied, and adds are no-ops. `GithubEnterpriseClient.setRepositorySelection` already exists (`admin/src/github-enterprise-client.ts`) but nothing calls it. There is also no way to uninstall the agent App from an org.

Not verified live: GitHub's exact response to add/remove on an "all" installation (inferred from the REST docs).

### Design

**Business logic**
- Crawler records the agent installation's `repository_selection` (`all` | `selected`) alongside the cached repo snapshot, so preview (which never calls GitHub) can see it.
- `planGithubSync` gains `selectionSwitches: {org, repos}[]`. For an org whose agent installation is `all`, the target "selected" list is the installed repos minus the confirmed app removes (about the repos the bound user can push to). The per-repo `appRemoves` for that org fold into the switch but still count in `removedRepos`, so the confirm step, the `confirmRemovals` cap and open-work blocking see them.
- Apply order: selection switches, installation adds, installation removes, agent `repos`, audit row, open-work block. A switch sends the first 50 repos in the PATCH (GitHub's cap) and the rest through the batched `addRepositories`.
- Empty target (the bound user can push to nothing in the org): the org is skipped with a warning and left on "all" (GitHub rejects an empty "selected" list). The warning points to Uninstall.
- New `uninstallFromOrg` on the enterprise client (`DELETE` the org installation, same `enterprise_organization_installations` write permission as install) and `DELETE /github-enterprise/orgs/{org}/install`, resolving the agent App's installation like install does. Uninstall also removes that org's repos from the agent's `repos`, blocks open work on them through the `OpenWorkPort`, and writes an audit row. It reuses Sync's removal handling.

**Views/UX**
- Sync confirm step lists the selection switches.
- "Install on org" block gets an Uninstall button with a confirm step listing the open work it would block.

**APIs**
- Sync preview/apply responses gain `selectionSwitches` (additive). New DELETE route above. OpenAPI regenerated.

**DB**
- One additive, nullable column for the selection on the cached agent installation snapshot. No backfill: null is treated as unknown and the next crawl fills it. Unknown selection is never treated as "all".

**Permissions (Dan's decision)**
The installer App's permissions are what the settings page instructs: `enterprise_organization_installations` and `enterprise_organization_installation_repositories`, both Read and write. No new permissions. Validation stays a warning when the repositories permission is missing, so existing deployments do not start failing on upgrade; the warning is reworded to say Sync needs it, and a 403 at apply surfaces a clear message.

**Per-layer tests**: unit (pure planning, rendering, warning text), integration (crawler/cache with real DB, enterprise client against recorded fixtures), smoke (Hono `app.request()` for the DELETE route and Sync preview/apply). No mocks of `fetch`; inject test doubles through the existing ports.

### Out of scope
- Switching an installation back from "selected" to "all".
- Changing the lookup App flow (it is installed manually on all repos).

### Decision Log
- Switch from "all" to "selected" automatically, no extra confirm beyond Sync's existing one: per Dan.
- Empty target: skip the org with a warning, leave on "all": per Dan (option 1).
- Uninstall also cleans up the agent's `repos` and open work: per Dan (option 1).
- Validation of the installer's repositories permission stays a warning (reworded), not a failure: soft default, avoids breaking existing deployments on upgrade.
- Selection stored in the cache rather than a live GitHub call in preview: keeps preview's "no GitHub call" property.
- Shipwright consumes the change through the normal `@app-vitals/agent-*` bump PR: all changes are additive, so no release-gate or consumer tasks.

### Tasks

| Task | Title | Layer | Depends on | Hours | Complexity | Model |
|------|-------|-------|------------|-------|------------|-------|
| GIS-1.1 | feat: record installation repository selection in the agent installation crawl | Database | — | 3 | 4 | sonnet |
| GIS-1.2 | feat: switch all-repositories installations to selected in GitHub Sync | API | 1.1 | 5 | 4 | sonnet |
| GIS-1.3 | feat: show selection switch in the Sync confirm step | Frontend | 1.2 | 2 | 3 | sonnet |
| GIS-1.5 | feat: uninstall the agent App from an org with repo and open-work cleanup | API | — | 5 | 4 | sonnet |
| GIS-1.6 | feat: add Uninstall to the Install on org block with a confirm step | Frontend | 1.5 | 3 | 3 | sonnet |
| GIS-1.4 | docs: document selection switch and uninstall, and reword the installer repositories-permission warning | Shared | 1.2, 1.5 | 2 | 2 | haiku |

All tasks: Safe to deploy standalone: yes (additive).

### Dependency Map

```
[START]
  ├─ GIS-1.1: record installation repository selection (no deps)
  │     └─ GIS-1.2: switch all → selected in Sync (needs 1.1)
  │           ├─ GIS-1.3: show selection switch in Sync confirm (needs 1.2)
  │           └─ GIS-1.4: docs + warning reword (needs 1.2, 1.5)
  └─ GIS-1.5: uninstall agent App from an org (no deps)
        ├─ GIS-1.6: Uninstall button in Install on org (needs 1.5)
        └─ GIS-1.4
```

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| GIS-1.1 | — | 1.2 | |
| GIS-1.2 | 1.1 | 1.3, 1.4 | |
| GIS-1.3 | 1.2 | — | |
| GIS-1.5 | — | 1.4, 1.6 | |
| GIS-1.6 | 1.5 | — | |
| GIS-1.4 | 1.2, 1.5 | — | |
