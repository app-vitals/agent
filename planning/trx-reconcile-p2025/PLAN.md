# Plan: trx-reconcile-p2025

Sentry: https://app-vitals-llc.sentry.io/issues/7851032294/ — PrismaClientKnownRequestError (P2025) from
`prisma.agentCronJob.delete()` in `POST /agents/:id/template/reconcile`.

## Root cause
`TemplateReconcileService.run` locks the Agent row (`FOR UPDATE`), which serializes reconciles of the same
agent only. `reconcileCrons` snapshots `AgentCronJob` rows with `findMany`, then updates/deletes by id.
Other writers (`agent-cron-jobs.ts` delete paths) do not take the Agent lock, so under READ COMMITTED a row can
vanish between the snapshot and the delete/update. Prisma throws P2025 and the reconcile transaction rolls back
(agent boot calls this endpoint).

## Design
- In `reconcileCrons` (`admin/src/agent-template-reconcile.ts`), lock the agent's `AgentCronJob` rows
  (`SELECT "id" FROM "AgentCronJob" WHERE "agentId" = ... FOR UPDATE`) before the snapshot reads, so no concurrent
  delete lands until commit.
- Change the stale-template-row delete to `deleteMany({ where: { id } })` and count `deleted` from the result
  (idempotent safety net).
- Leave `update` calls alone; they are protected by the row lock.

## Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| TRX-1.1 | — | — | |

Safe to deploy standalone: yes (no renames/removals/constraints).

## Decision Log
- Lock + deleteMany (not deleteMany alone): approved by Dan — minimal fix would leave the update paths racy.
