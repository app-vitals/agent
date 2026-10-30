# Plan: admin-extension-agent-types

Repo: app-vitals/agent (ETP-1.x), app-vitals/shipwright (ETP-2.1)

## Problem
shipwright PR #4684 deletes its `specialties/` manifests. With `@app-vitals/agent-admin` 0.16.1 the admin UI
new-agent page still 500s: `SpecialtyRegistry.listTypes()` calls `readdirSync` on
`agent-lib/agent-types`, which exists only in the platform image, not in the published npm tarball (ENOENT).
Separately, the platform has no way for an `AdminExtension` to contribute agent types, so the `coding` type
can no longer reach the picker or `POST /admin/agents` (validated via `tryGetManifest`) once the manifest is gone.
Fixing ENOENT alone clears 1 of the 3 failing `e2e (admin UI)` tests in #4684.

## Design
- ETP-1.1: `defaultTypeDirLister` / `listTypes()` treat a missing dir as empty (warn, never throw); when
  nothing is discoverable, `listTypes()` returns the built-in default `specialist` option, matching the
  `getManifest()` fallback contract.
- ETP-1.2: add `agentTypes?(): {name, displayName}[]` to `AdminExtension`. `admin-boot` merges extension
  types into the picker and into `POST /admin/agents` type validation (additive; extension wins on name
  collision). `specialtyDefaults` already supplies crons when no manifest exists.
- ETP-2.1 (shipwright): `codingAdminExtension.agentTypes()` returns `{coding, "Coding Agent"}`; pin to the
  released 0.16.2 and re-run #4684.
- Release: release automation cuts 0.16.2; `chore/platform-release` bumps shipwright pins.

ETP-1.1 and ETP-1.2 share a branch (same registry, one reviewable PR).

## Tasks
| Task | Depends on | Layer | Model | HITL |
|---|---|---|---|---|
| ETP-1.1 | — | Shared | sonnet (bundle) | |
| ETP-1.2 | — | API | sonnet | |
| ETP-2.1 | ETP-1.1, ETP-1.2 + 0.16.2 release | Shared | haiku | |

## Breaking change safety
All additive (new optional extension hook; fallback behavior only where it previously threw). Safe to deploy standalone: yes.

## Decision Log
- Extension hook vs. stub manifest in shipwright: chose platform hook — a stub manifest would undo the goal of #4684.
