# Plan: agent-templates — default agent configuration for a deployment

Session: `agent-templates` · Repo: `app-vitals/agent` · Prefix: `ATP` · Spec: `planning/agent-templates/PRODUCT-SPEC.md`

## Design summary
Platform half lives entirely in `app-vitals/agent` (admin package); shipwright picks it up through the automatic
agent-image/pin update, so there are no shipwright or vitals-os tasks. The template is edited in the admin Settings
nav and stored in the DB, not in a repo.

Verified against `@app-vitals/agent-admin` 1.37.0 and `repos/agent` main (2026-11-13): `AgentEnv/AgentTool/AgentPlugin/
AgentCronJob` are row-per-item with natural keys; `AgentTool` has no `updatedAt`; `createAgent()` (`admin/src/agents.ts`)
is the single provisioning implementation behind `POST /agents` and `/admin/agents/new`; `reconcileSystemCrons`
(`admin/src/agent-cron-jobs.ts`) is the reconcile precedent; the runtime ignores an empty `allowedTools`
(`runtime/boot.ts:544`).

### DB
- `AgentTemplate(id, accountId?, specialty?, createdAt, updatedAt)`; uniqueness over `(accountId, specialty)` via
  partial unique indexes (Postgres treats NULLs as distinct). `AgentTemplateItem(templateId, kind env|tool|plugin|cron,
  key, payload Json, updatedAt)`, env values encrypted with the existing AES-256-GCM path.
- `source String @default("custom")` on `AgentEnv`, `AgentTool`, `AgentPlugin`, `AgentCronJob`; `AgentTool.updatedAt`;
  `Agent.templateDetached Boolean @default(false)`. All additive; defaulting `source` to `custom` makes the migration
  safe for existing agents (nothing is reconciled until the first reconcile adopts exact matches).

### Business logic
- Resolution: merge by key, ascending specificity (specialty defaults, deployment/all, deployment/type, account/all,
  account/type). Reserved-key denylist for per-agent credentials.
- Reconcile per agent in one transaction: add missing, update `template` rows, remove orphans, honor tombstones and
  `templateDetached`, adopt rows whose value equals the template value, never clear tools to empty, specialty change
  re-resolves.
- Writes: every admin API/UI write marks the row `custom`; delete of a `template` row writes a tombstone.

### API / provisioning
- Template CRUD with account scoping via `caller-scope`; specialty validated against the registry.
- `createAgent()` seeds the resolved template inside its transaction; explicit form/API values are written `custom`
  and win; `templateDetached: true` opts out. Fan-out on template change (one transaction per agent), boot reconcile,
  manual `POST /agents/{id}/template/reconcile`, detach/reattach and reset endpoints.

### UI
- Settings nav template editor with a scope picker (account, type); agent page shows inherited/custom badges,
  detach toggle and reset; provisioning form shows the template as defaults with an opt-out checkbox.

## Complexity flags
- Five-layer precedence and NULL-aware uniqueness (ATP-1.1, ATP-2.1).
- Tombstones and adoption rules are the subtle part of reconcile; each needs an explicit integration test.
- Existing agents have no audit trail, so all existing rows start `custom`.

## Tasks
| Task | Title | Layer | Cx / model | Hours | Depends on |
|---|---|---|---|---|---|
| ATP-0.1 | test: make Prisma row mocks tolerant of added platform columns (app-vitals/shipwright) | Shared | 2 / haiku | 2 | — |
| ATP-1.1 | feat: add AgentTemplate schema and row source markers | Database | 5 / opus | 5 | 0.1 |
| ATP-1.2 | feat: mark admin writes custom and tombstone deleted rows | API | 4 / sonnet | 4 | 1.1 |
| ATP-1.3 | feat: template CRUD API with scoping and env crypto | API | 4 / sonnet | 5 | 1.1 |
| ATP-2.1 | feat: per-agent template reconcile engine | Background | 5 / opus | 8 | 1.2, 1.3 |
| ATP-2.2 | feat: apply templates at provisioning and on change | API | 4 / sonnet | 6 | 2.1 |
| ATP-2.3 | feat: Settings nav template editor | Frontend | 3 / sonnet | 5 | 1.3 |
| ATP-2.4 | feat: agent template badges, detach, reset and provisioning opt-out | Frontend | 3 / sonnet | 5 | 2.2 |

```
[START]
  └─ ATP-0.1 (shipwright)
        └─ ATP-1.1
        ├─ ATP-1.2 ─┐
        └─ ATP-1.3 ─┴─ ATP-2.1 ─ ATP-2.2 ─ ATP-2.4
              └─ ATP-2.3
```

Breaking Change Safety: every task is additive at runtime (new tables, defaulted columns, new endpoints). ATP-1.1 is not
safe standalone for the type contract, though: Prisma row types make every column a required key even when the DB has a
default, so new columns on AgentEnv/AgentTool/AgentPlugin/AgentCronJob break shipwright's exhaustive mock literals
(`shipwright consumer compat` typecheck, found on #204). ATP-0.1 migrates those mocks first (expand → migrate order);
ATP-1.1 depends on it. Safe to deploy standalone: yes for all other tasks.

Not carried: setting the Vitals OS Sentry DSN — done by Dan in the Settings UI after rollout; it lives in the DB, not a
repo, so no task.

## Decision Log
- ATP-0.1 added after #204: the original plan wrongly marked ATP-1.1 safe standalone and listed no shipwright task. Making
  shipwright's mocks resilient beats a lockstep bump because future column additions then need no shipwright change.
- Layering: merge by key, more specific scope wins (Dan: template is default, explicit provisioning values override).
- Provisioning opt-out via `templateDetached` rather than named templates (deferred).
- Phase methodology and policy columns excluded from v1 (coding-owned).
- No backfill task: `source` defaults to `custom`; first reconcile adopts exact matches.
