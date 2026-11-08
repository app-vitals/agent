# Plan: saul-lane-move — move Saul from the `coding` lane to the `specialist` lane

Session: `saul-lane-move` · Primary repo: `app-vitals/agent` (PR 2 tasks target `app-vitals/vitals-os`) · Prefix: `SAL`
Spec: `planning/saul-lane-move/PRODUCT-SPEC.md` (the approved migration plan, 2026-11-08).

## Design summary

Saul (`cmrnw6im5000eaz01e6ap6lxc`) is defined in `app-vitals/specialists` but his agent record still says
`specialty: coding`, so `resolveImage()` puts him on the coding image whose baked `vitals-os` marketplace lacks his
plugins. The fix is a supported, guarded specialty change on an existing agent, plus one image-lane change so his
`shipwright@shipwright` plugin keeps resolving on the specialist image, then one supervised pod replacement.

Decisions (Dave): keep `shipwright@shipwright` (bake the marketplace into the specialist lane); delete the disabled
coding loop crons on the flip, convert the enabled `learn-dream` to a user cron; lane flip only — no CLI
provisioning/memory/persona work in this session. No admin UI work: Dave performs the PATCH via the admin API.

### Business logic (app-vitals/agent, admin)
- `admin/src/agent-cron-jobs.ts` `reconcileSystemCrons`: orphan pass gains an opt-in option
  `convertEnabledOrphans` (default `false`). When set, an orphan `system=true` cron with `enabled=true` is converted to
  a user cron (`system=false`, same id, `AgentCronRun` history kept) instead of deleted; disabled orphans are deleted
  as today. Only the specialty-change path in `PATCH /agents/:id` passes it, so boot-time reconciles keep deleting
  renamed or dropped system crons exactly as before and a manifest rename never leaves a user-cron duplicate.
- `PATCH /agents/:id` accepts `specialty`: platform-admin only (403), 422 unless `specialtyRegistry.tryGetManifest`
  resolves it, no-op when unchanged. After the write: `reconcileSystemCrons(agentId)` immediately, then
  `reconcileAgentAfterSpecialtyChange` (copy of `reconcileAgentAfterAccountChange` in
  `admin/src/agent-account-assignment.ts`) so the Deployment is re-patched to `resolveImage(newSpecialty)`
  (`strategy: Recreate` → one pod replacement). Audit log line with ids/names only.
- `GET /agents/:id/specialty-change-preview?to=<specialty>`: read-only dry run returning
  `{ imageBefore, imageAfter, templatesDir, crons: { kept[], converted[], deleted[] }, toolsUnchanged: true, pluginsUnchanged: true }`
  plus a `rollbackNote` when a converted user cron shares a name with a cron in the target manifest.

### Runtime (app-vitals/agent, runtime)
- `runtime/setup.ts` `installPlugins`: when a baked marketplace dir named `shipwright` exists under
  `/opt/shipwright/marketplaces/`, and `$SHIPWRIGHT_REPO_ROOT` has no `.claude-plugin/marketplace.json`, skip the
  `marketplace add <repoRoot>` call; and if the CLI's known-marketplaces registry already maps `shipwright` to a
  directory that no longer holds a marketplace, remove it before adding the baked one. Coding agents (where `/app` is
  a real marketplace) are unaffected.

### Image lane (app-vitals/vitals-os)
- `image/specialists/Dockerfile`: `ARG SHIPWRIGHT_AGENT_REGISTRY=ghcr.io/app-vitals`, `ARG SHIPWRIGHT_AGENT_TAG=<pinned agent-v…>`;
  `COPY --from=${SHIPWRIGHT_AGENT_REGISTRY}/shipwright-agent:${SHIPWRIGHT_AGENT_TAG} --chown=1000:1000 /app/.claude-plugin
  /opt/shipwright/marketplaces/shipwright/.claude-plugin` and `/app/plugins/shipwright → …/shipwright/plugins/shipwright`.
  Marketplace name stays `shipwright`. `scripts/image/image-parity.ts` `SPECIALISTS_PROFILE.smokePaths` gains the new
  marketplace.json path. The parity gate snapshots only `/opt/shipwright/marketplaces/vitals-os`, so no plugin delta.
- Docs fixes: `docs/architecture-infrastructure.md:86-96` (default image name), root `.claude-plugin/marketplace.json`
  (lists plugins that do not exist under `plugins/`).

### Views/UX — none. ### DB — none (no schema change; `system`/`enabled` columns already exist).

### Testing strategy
- agent: unit tests for schema/403/422/no-op and the preview shape; integration tests (real Postgres, as the existing
  `agent-cron-jobs` tests do) for the `convertEnabledOrphans` option and for PATCH → cron reconcile → provisioner.reconcile called with
  the new specialty (provisioner injected as a test double, no global mocks); runtime unit test for `installPlugins`
  with an injected `execFn` covering the skip/heal branches.
- vitals-os: extend `image/specialists/baked-marketplace.smoke.test.ts` and `scripts/image/image-parity.unit.test.ts`.

### Complexity risks
- ⚠ `reconcileSystemCrons` is shared by every agent boot — the option must default off and be a pure extension of the
  orphan pass; integration-test both branches, plus a boot-path rename case (enabled orphan, option unset) asserting
  the old cron is still deleted and no user-cron duplicate remains. Rollback (`specialty: coding`) re-seeds `learn-dream` as a system cron next to the
  converted user cron; the preview reports it and the HITL rollback step deletes the user copy first.
- ⚠ Prod admin must run PR 1 before the PATCH; the admin ships via the shipwright chart pin, not the agent image.
- ⚠ A coding pin PR merging before the swap restarts Saul an extra time (harmless, but breaks "one restart").

## Tasks

| ID | Title | Repo | Layer | Deps | Branch | h | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|---|---|
| SAL-1.1 | feat: convert enabled orphan system crons to user crons in reconcileSystemCrons | agent | API | — | feat/sal-specialty-change | 3 | 3 | sonnet | |
| SAL-1.2 | feat: accept specialty on PATCH /agents/:id with cron and workload reconcile | agent | API | 1.1 | feat/sal-specialty-change | 5 | 4 | sonnet | |
| SAL-1.3 | feat: add GET /agents/:id/specialty-change-preview dry run | agent | API | 1.2 | feat/sal-specialty-change | 3 | 3 | sonnet | |
| SAL-1.4 | fix: heal a stale shipwright marketplace registration when a baked one exists | agent | Background | — | fix/sal-1-4-stale-shipwright-marketplace | 3 | 3 | sonnet | |
| SAL-1.5 | chore: approve and merge the specialty-change platform PR and confirm prod admin runs it | agent | Shared | 1.1, 1.2, 1.3, 1.4 | chore/sal-1-5-platform-approval | 1 | 1 | haiku | ⚠ HITL |
| SAL-2.1 | feat: bake the shipwright marketplace into the specialists lane image | vitals-os | Background | — | feat/sal-2-1-specialist-shipwright-marketplace | 3 | 3 | sonnet | |
| SAL-2.2 | docs: fix stale agent-image docs and the root marketplace manifest | vitals-os | Shared | — | docs/sal-2-2-stale-image-docs | 1 | 1 | haiku | |
| SAL-2.3 | chore: confirm the specialists image pin with the shipwright marketplace is deployed | vitals-os | Shared | 2.1 | chore/sal-2-3-specialist-pin-confirm | 1 | 1 | haiku | ⚠ HITL |
| SAL-3.1 | chore: pre-flight Saul's lane move (snapshot, preview, hold) | agent | Shared | 1.5, 2.3 | chore/sal-3-1-preflight | 1 | 1 | haiku | ⚠ HITL |
| SAL-3.2 | chore: flip Saul to the specialist lane in his idle window | agent | Shared | 3.1 | chore/sal-3-2-swap | 1 | 1 | haiku | ⚠ HITL |
| SAL-3.3 | chore: verify Saul after the lane move | agent | Shared | 3.2 | chore/sal-3-3-verify | 1 | 1 | haiku | ⚠ HITL |

Bundle: SAL-1.1/1.2/1.3 share `feat/sal-specialty-change` (one reviewable platform PR; all run at `sonnet`).

## Dependency map

```
[START]
  ├─ SAL-1.1 cron guard (no deps)
  │     └─ SAL-1.2 PATCH specialty (needs 1.1)
  │           └─ SAL-1.3 preview endpoint (needs 1.2)
  ├─ SAL-1.4 runtime marketplace heal (no deps)
  ├─ SAL-2.1 specialist image: shipwright marketplace (no deps)
  │     └─ SAL-2.3 ⚠ pin deployed (needs 2.1)
  └─ SAL-2.2 docs fixes (no deps)
SAL-1.5 ⚠ Dan approves platform PR (needs 1.1, 1.2, 1.3, 1.4)
      └─ SAL-3.1 ⚠ pre-flight (needs 1.5, 2.3)
            └─ SAL-3.2 ⚠ swap (needs 3.1)
                  └─ SAL-3.3 ⚠ verify (needs 3.2)
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| SAL-1.1 | — | 1.2, 1.5 | |
| SAL-1.2 | 1.1 | 1.3, 1.5 | |
| SAL-1.3 | 1.2 | 1.5 | |
| SAL-1.4 | — | 1.5 | |
| SAL-1.5 | 1.1, 1.2, 1.3, 1.4 | 3.1 | ⚠ |
| SAL-2.1 | — | 2.3 | |
| SAL-2.2 | — | — | |
| SAL-2.3 | 2.1 | 3.1 | ⚠ |
| SAL-3.1 | 1.5, 2.3 | 3.2 | ⚠ |
| SAL-3.2 | 3.1 | 3.3 | ⚠ |
| SAL-3.3 | 3.2 | — | ⚠ |

## Breaking change safety

All code tasks are additive (new optional PATCH field, new GET route, new opt-in option that only converts
instead of deletes, new baked directory, new build args). No renames, removals, or constraints. Every task:
`Safe to deploy standalone: yes`. SAL-1.1 changes nothing for existing agents: the conversion is opt-in and only the
specialty-change PATCH passes it, so boot-time orphan deletion is unchanged.

## Out of scope
CLI-provisioning Saul (memory, persona composer, `marketing:*` crons, marketplace rename); SIGTERM handling that kills
in-flight Claude jobs (`runtime/boot.ts` ~930) — candidate for its own platform task; `GITHUB_PAT_TRAFFIC` 401.
