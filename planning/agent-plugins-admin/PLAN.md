# Plan Session: agent-plugins-admin

Repo: app-vitals/agent — requested by Dan.

## Problem

The admin agent page lists plugins read-only; only marketplaces can be added or removed. The
runtime reconcile (`installPlugins`, run at boot and every 60s config-sync tick) adds, updates
and installs, but never removes.

## Reconcile audit (current behavior)

| Change | Handled | Evidence |
|---|---|---|
| Marketplace added | yes | `marketplace add <source>[#ref]` when unregistered (`runtime/setup.ts` `reconcileRemoteMarketplace`) |
| Marketplace updated | yes | `marketplace update <name>` every tick; source/ref change -> remove + re-add |
| Marketplace removed | **no** | deleting the row leaves the registration on disk |
| Plugin installed | yes | `plugin install` for every bundle row |
| Plugin updated | yes | `plugin update` every tick (`version` advisory; pin via marketplace `ref`) |
| Plugin uninstalled | **no** | `plugin uninstall` only for stale install paths, then reinstalled |

Related gaps: `runtime/boot.ts` only calls `installPlugins` when the bundle has plugins or
marketplaces, so removing the last one never reconciles; disabled plugins (`enabled=false`)
are filtered from the bundle but stay installed.

## Design

1. **Admin UI (Frontend):** add/remove on the Plugins card, mirroring the marketplace routes.
   `POST /admin/agents/:id/plugins` (spec `plugin@marketplace` or bare name; datalist of the
   agent's marketplaces) and `POST /admin/agents/:id/plugins/delete` (pluginId), both behind
   `assertAgentAccess`. Widen `agentPluginService` Pick to include `remove`. Malformed spec ->
   `UnprocessableEntityError` surfaced via `?error=`.
2. **Runtime reconcile (Background):** a ledger file beside `installed_plugins.json` records the
   specs and remote marketplaces the runtime installed from the bundle. Each tick, anything in
   the ledger but absent from the bundle (or disabled) is uninstalled / unregistered, then the
   ledger is updated. Scoping to the ledger means baked, built-in and hand-installed items are
   never touched. Failures are non-fatal. Remove the non-empty guard at `boot.ts:541`.
3. **Docs:** correct `docs/agent-ops.md` (currently implies removal works).

Decisions (Dan): disabled plugins are uninstalled like removed ones; UI and runtime ship as
separate PRs.

Risk: the uninstall path mutates `~/.claude` on live agents; needs a runtime release and image
rollout before taking effect.

## Tasks

| ID | Title | Layer | Complexity | Model | Depends on |
|---|---|---|---|---|---|
| PUI-1.1 | feat: reconcile removed and disabled plugins and marketplaces in installPlugins | Background | 5 | opus | — |
| PUI-1.2 | feat: add plugin add and remove to the admin agent page | Frontend | 4 | sonnet | — |
| PUI-1.3 | docs: document plugin management and removal reconcile | Shared | 1 | haiku | PUI-1.1, PUI-1.2 |

All tasks are additive; safe to deploy standalone: yes.
