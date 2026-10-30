# Plan: bosun-template-fix

Session: `bosun-template-fix`
Primary repo: `app-vitals/agent` (tasks also target `app-vitals/specialists` and `app-vitals/vitals-os`)
Planned: 2026-10-30

## Problem

Bosun (specialist agent `cmvn2wb1g000u01f88ltwjnry`, namespace `vitals-os`) crash-looped from 03:33 UTC to 15:40 UTC on 2026-10-30. Specialists PR #231 rebased the specialists image onto the bare platform image `ghcr.io/app-vitals/agent`. Platform 0.15.0 and 0.16.0 ship the `specialist` type under `/app/agent-types/`, but the runtime's template lookup only read `SHIPWRIGHT_SPECIALTIES_DIR` or `<repo root>/specialties`, with the repo root defaulting to `/`. The lookup fell back to a coding `CLAUDE.md.template` the platform image does not carry, `readTemplate` threw on every boot, and the startup probe never passed.

Service was restored with two per-agent env overrides set through the admin API: `SHIPWRIGHT_REPO_ROOT=/app` and `SHIPWRIGHT_SPECIALTIES_DIR=/app/agent-types`. Those are a stopgap.

## Key finding

Platform PR #90 (`refactor: default agent type to specialist and specialties dir to shipped agent-types`, PCD-3.1) already fixes the lookup on `agent` main, but it will never release on its own. `AUTO_RELEASE` is on, yet semantic-release with the conventionalcommits preset only cuts a version for `feat`, `fix` or `perf` commits. The Release run after #90 logged "no relevant changes, so no new version is released". A manual dispatch hits the same analyzer. Something releasable has to land on `agent` main.

## Design

**Platform (`app-vitals/agent`).** Add the image-level regression the outage proved was missing: a consumer-smoke scenario that boots the published image as a `specialist` agent with none of `SHIPWRIGHT_SPECIALTIES_DIR`, `SHIPWRIGHT_DEFAULT_AGENT_TYPE` or `SHIPWRIGHT_REPO_ROOT` set. Today's only scenario (`scripts/consumer-smoke.ts`) sets a fixture specialties dir, which is why the broken default shipped unnoticed. The PR lands as a `fix:` commit; that is honest for what it delivers and is what makes semantic-release cut the version carrying #90.

**Specialists base (`app-vitals/specialists`).** Bump `ARG BASE_TAG` in `image/Dockerfile` to that release, reusing `scripts/image/base-tag.ts` (newest-tag resolution) and the anonymous-pull check from `update-base-tag.yml`. On merge, `build-agent-image.yml` tags a new `specialists-agent`, builds it, and dispatches `specialists-base-release` to vitals-os.

**vitals-os pin.** Fully automatic. The `Specialists Agent Image` lane builds `vitals-os-specialist-agent`, opens the pin PR against `infra/helm/shipwright-deploy/values-prod.yaml`, and auto-merges after smoke-check and Helm CI. The merge restarts every specialist agent. No task.

**Env override removal.** Human step, API only. The admin API has no restart endpoint, so the plan uses the pin merge's own restart as the verification reboot: delete the two keys after the specialists bump merges and before the pin auto-merges. The worst case in that window is Bosun crash-looping for under an hour until the pin lands, which is itself the fix. Rollback is the same PATCH that restored service today.

**Testing.** No `docs/test-readiness/test-system.md` in the agent repo; default layer definitions apply. BTF-1.1 adds an integration-layer scenario to consumer-smoke (boots the real image). BTF-2.1 relies on the existing `image/platform-base.content.test.ts`. BTF-3.1 has no tests (verification against production, no code).

## Related open tasks

- `error-7813297894-agent-missing-workspace-template` (pending, HITL): Sentry VITALS-OS-6N, same defect. Superseded by this session; closed out in BTF-3.1.
- `PCD-3.3` (pending): removes the hardcoded `shipwright` default plugin, which covers the non-fatal marketplace install failure in Bosun's boot log. Not duplicated here.
- `PCD-3.2` (pending, HITL): its human steps use kubectl and psql, against `gitops/docs/hitl-authoring.md`. Out of scope; flagged.

## Tasks

| ID | Repo | Title | Deps | Layer | Hrs | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|---|
| BTF-1.1 | app-vitals/agent | fix(runtime): boot the shipped specialist type without specialties env overrides | — | Shared | 3 | 3 | sonnet | |
| BTF-2.1 | app-vitals/specialists | build: bump BASE_TAG to the platform release carrying the specialist template default | BTF-1.1 | Shared | 1 | 1 | haiku | |
| BTF-3.1 | app-vitals/vitals-os | chore: remove the Bosun specialties env overrides once the repinned image lands | BTF-2.1 | Background | 1 | 1 | haiku | ⚠ HITL |

## Dependency map

```
[START]
  └─ BTF-1.1 fix(runtime) ─ Release run publishes vX.Y.Z (auto)
        └─ BTF-2.1 build: bump BASE_TAG ─ specialists build + vitals-os pin PR (auto)
              └─ BTF-3.1 ⚠ HITL remove overrides, verify on the pin-merge restart
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| BTF-1.1 | — | BTF-2.1 | |
| BTF-2.1 | BTF-1.1 | BTF-3.1 | |
| BTF-3.1 | BTF-2.1 | — | ⚠ HITL |

## Breaking change safety

- BTF-1.1: additive (new smoke scenario). Safe to deploy standalone: yes.
- BTF-2.1: changes the input value of the release pipeline interface (`BASE_TAG`), not its mechanism. Downstream consumer is the vitals-os lane via `repository_dispatch`, unchanged, and gated by its own smoke-check. Safe to deploy standalone: yes.
- BTF-3.1: config removal on one agent, reversible with one PATCH. Safe to deploy standalone: yes.

## HITL lint

BTF-3.1 human steps use only GitHub (browser or `gh`), the public admin API with the operator's `SHIPWRIGHT_ADMIN_API_KEY`, Slack and Sentry. No kubectl, psql, port-forward or cluster Secret reads. PASS.

## Decision log

- Release trigger: defaulted to a `fix`-typed smoke PR over a manual tag push, because it adds the missing regression check and keeps semantic-release's notes intact.
- Reboot for verification: defaulted to deleting the overrides before the pin auto-merge instead of a new admin restart endpoint, because the endpoint would need its own platform release and admin deploy before this session could finish.
