# Plan: cron-sync-reschedule

Repo: app-vitals/agent

## Problem
`syncCrons()` in `runtime/boot.ts` (60s tick) keys `cronTasks` by job id only (`if (!cronTasks.has(id))`).
Add/remove/disable are honoured; edits to an existing job are not. `nodeCron.schedule(job.schedule, ...)`
runs once and the fire callback closes over the original `job`, so schedule, prompt, channel, user, silent
and preCheck edits stay stale until the agent restarts. `dispatchKinds` and the loop-jobs ref are already
rebuilt each tick, so loop classification is current.

## Design
- Business logic: new `runtime/cron-sync.ts` exporting a pure `reconcileCronTasks({ tasks, desired, schedule, log })`.
  `tasks` is `Map<id, { task, signature }>`; `signature` = stable JSON of (schedule, prompt, channel, user, silent,
  preCheck, dispatch kind). Stop+delete tasks not in `desired`; schedule new ones; when the id exists but the
  signature differs, stop the old task and schedule a new one, logging `[cron-sync] rescheduled <id> (<schedule>)`.
  The scheduler is injected so tests need no real node-cron.
- boot.ts: `cronTasks` becomes the `{task, signature}` map; syncCrons delegates to the helper; shutdown loop (~line 943)
  reads `.task.stop()`. Fire callback logic is unchanged.
- APIs/DB/Views: none.
- Tests (unit): unchanged job -> no reschedule; schedule change; prompt-only change; dispatch-kind change;
  disable; delete; new job.
- Delivery: fix lands in app-vitals/agent; shipwright picks it up via the normal @app-vitals/agent-runtime release and
  pin bump. No new exports are consumed, so no release-gate task.

Safe to deploy standalone: yes (additive behavior fix, no interface rename or removal).

## Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| CSY-1.1 | - | - | |

## Decision Log
- Reschedule vs live-lookup: defaulted to stop/reschedule on signature change - covers schedule edits, which a live job lookup cannot.
