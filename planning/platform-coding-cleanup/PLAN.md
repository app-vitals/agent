# Platform / coding cleanup, Phase A: Plan

**Session**: `platform-coding-cleanup` (PCX-*, app-vitals/agent)
**Follows**: [platform-coding-decoupling](../platform-coding-decoupling/PLAN.md) (all PCD tasks deployed)

## Design

Audit of what coding-flavored code remains in the platform (2026-11-02):

- Already platform-generic, no action: `runtime/gh-helpers.ts`, `worktree-reaper.ts`, the `cleanup-*-ref.ts` files and `admin/src/agent-manifest.ts`.
- Leftover naming: `runtime/shipwright-config-client.ts` (`ShipwrightConfigClient` plus a duplicate interface in `cutover-validate.ts`), the `admin/e2e/fixtures/specialties/coding` fixture, and stale docs (`docs/agent-api.md` claims self-serve forces `"coding"`).
- Out of scope here: the four `coding.prisma` models and the six coding-owned `Agent` columns, plus the `phaseMethodology` seam in the config response (a published-contract change). They need Shipwright to own schema; see Deferred.

Phase A is three independent renames/doc fixes. `SHIPWRIGHT_*` env vars and `HttpShipwrightRuntimeClient` are the platform's wire and brand names and stay.

## Breaking Change Safety

| Change | Consumers | Safe path |
|---|---|---|
| Rename `ShipwrightConfigClient` / file | No code consumers outside this repo found (shipwright and specialists mention it only in docs/planning). PCX-1.1 must grep `runtime/package.json` exports first | Atomic rename in one PR |
| Rename e2e fixture dir | `runtime/setup.fixture.integration.test.ts` | Atomic in one PR |
| Docs fixes | none | n/a |

All three are safe to deploy standalone.

## Tasks

| Task | Title | Layer | Cx | Model | Depends on | HITL |
|---|---|---|---|---|---|---|
| PCX-1.1 | refactor: rename ShipwrightConfigClient to AgentConfigClient | Shared | 2 | haiku | | |
| PCX-1.2 | refactor: rename the coding e2e specialty fixture to a neutral name | Shared | 1 | haiku | | |
| PCX-1.3 | docs: correct stale coding wording in the platform docs | Shared | 1 | haiku | | |

## Dependency Map

```
[START]
  |- PCX-1.1
  |- PCX-1.2
  \- PCX-1.3
```

## Deferred (Phase B/C, not planned)

Shipwright has no schema ownership: its admin uses the platform's single schema and migration chain. Options researched, none chosen: (1) `extensionConfig` JSON on the platform, (2) a Shipwright table in the task-store DB, (3) a second Prisma chain in a separate Postgres schema namespace (unverified), (4) a build step composing platform and Shipwright `.prisma` files (needs a `runMigrations()` override). Specialists' chief-of-staff `fleet-health` reads/PATCHes `allowSelfReview` and the allowlists via the agents API, so removing the six columns needs expand, migrate, contract with a specialists consumer task.
