# Plan: public-marketplaces — DB-driven remote marketplaces, remove the shipwright bake from the specialists image

Session: `public-marketplaces` · Primary repo: `app-vitals/agent` (PMK-2.1 targets `app-vitals/vitals-os`) · Prefix: `PMK`

## Design summary

The agent runtime can only use marketplaces that are on disk in the image (`/opt/shipwright/marketplaces/*` plus the
built-in one): "marketplace availability is an IMAGE property". To give Saul `shipwright@shipwright` on the specialist
lane, SAL-2.1 baked the shipwright marketplace into the specialists image by copying it from the pinned
`shipwright-agent` image. That couples the specialists image to shipwright's release cadence: the copy's tag must equal the
coding image's `BASE_TAG`, enforced by a smoke test, and the image-bump bot only edits the coding Dockerfile, so every bump
PR fails CI until someone fixes the specialists tag by hand (observed on the 1.455.5 bump).

Shipwright is a public marketplace. The Claude CLI can add it straight from GitHub
(`claude plugin marketplace add owner/repo[#ref]`, verified, including `#ref` pinning). This plan lets the runtime do that
from DB-held configuration, then removes the bake.

Decisions (Dan):
- Keep `AgentPlugin` exactly as is: no data migration. Add only an `AgentMarketplace` table and an admin interface.
- Plugins track latest. The CLI has no per-plugin version pin (`plugin install` takes `plugin[@marketplace]`; `plugin update`
  goes to latest). `AgentPlugin.version` stays advisory. A pin, when wanted, is a `ref` on the marketplace row, in the DB,
  never hardcoded in code or an image.
- List the marketplaces baked into an agent's image in the admin, read-only. Only an image update can change that list.
- Saul is the only agent that depends on shipwright, so no specialists CLI or manifest work is needed.
- Saul flips lanes on the new mechanism: the bake is removed before his flip.

### DB (app-vitals/agent, admin)
`AgentMarketplace(id, agentId, name, source, ref?, createdAt, updatedAt)`, unique on `(agentId, name)`, cascade on agent
delete. `name` is the marketplace name that `AgentPlugin` specs already reference after the `@`. A second additive column
on `Agent` holds the baked marketplace names reported by the runtime at boot.

### APIs (admin)
CRUD routes under `/agents/{id}/marketplaces` (platform-admin or the agent's own key, mirroring `/plugins`), `source`
validated as `owner/repo` or an https git URL, `ref` optional. The agent config bundle gains an optional `marketplaces`
field (additive, so existing consumers still typecheck). A runtime-authenticated report endpoint writes the baked list; there
is no user-facing write route for it.

### Runtime (app-vitals/agent, runtime/setup.ts `installPlugins`)
Order: add baked dirs (unchanged), add each remote marketplace `<source>[#ref]`, `marketplace update <name>`, then the
existing `plugin install` and `plugin update`. Failures warn and continue, like the rest of the function. Rules:
- A baked dir with the same name wins, with a warning, so the bake and a DB row coexist until the bake is removed.
- A cloned manifest name that differs from the row's `name` warns.
- A changed `ref` runs `marketplace remove` then `add`.
- Prune any registered marketplace whose `installLocation` under the baked root no longer exists. This is the reverse of
  the SAL-1.4 heal: specialists agents registered `shipwright` against the baked path, which dangles once PMK-2.1 lands.
- The runtime reports the names found under the baked root at boot.

### Views/UX
Agent page: remote rows (add, remove) plus baked rows read-only.

### Image lane (app-vitals/vitals-os)
Remove the second `FROM`, `SHIPWRIGHT_AGENT_TAG`, the two `COPY --from` lines, the marketplace-name check, the sync
assertion in `baked-marketplace.smoke.test.ts`, and the docs mentions. The specialists lane builds on dispatch, not on a
push, so a human confirms the rebuild and pin (PMK-2.2).

### Testing strategy
- unit: spec/validation logic, the reporter, the runtime exec ordering with an injected exec function.
- integration (real Postgres): migration, service and routes, the baked-list store, runtime re-boot idempotence.
- e2e (admin Playwright): the marketplaces section. No global mocks (t1_no_global_mocking).

### Complexity risks
- `installPlugins` was just changed by SAL-1.4; PMK-1.3 edits the same function. Read the heal logic first.
- Cross-repo: runtime and admin ship from `app-vitals/agent` through the platform release chain; the vitals-os change
  lands after PMK-1.3. All new contract is additive, so no consumer breaks in between.
- Egress: agent pods in the production namespace reach github.com directly (checked from a running agent pod). The
  specialists agents' own NetworkPolicy is confirmed in PMK-2.2.
- PMK-1.5's e2e: `admin/e2e/` has been excluded from tsc before; confirm it actually runs.

## Tasks

| ID | Repo | Title | Depends on | HITL |
|---|---|---|---|---|
| PMK-1.1 | agent | feat: add AgentMarketplace model and additive migration | — | |
| PMK-1.2 | agent | feat: marketplace service, admin API and OpenAPI CRUD, `marketplaces` in the config bundle | 1.1 | |
| PMK-1.3 | agent | feat: runtime registers remote marketplaces (add, update, heal) before plugin install | 1.2 | |
| PMK-1.4 | agent | feat: runtime reports baked marketplaces to admin (read-only) | 1.2 | |
| PMK-1.5 | agent | feat: admin UI lists remote and baked marketplaces | 1.2, 1.4 | |
| PMK-1.6 | agent | docs: remote marketplaces and the baked list | 1.3, 1.5 | |
| PMK-2.1 | vitals-os | refactor: remove the specialists bake | 1.3 | |
| PMK-2.2 | vitals-os | chore: confirm the bake-less specialists image is built, pinned and deployed | 2.1 | ⚠ HITL |

Each task has its own branch. PMK-1.2 depends on PMK-1.1 being merged (they are not bundled: a blocked PMK-1.1 would otherwise hold the whole bundle).

## Dependency map

```
[START]
  └─ PMK-1.1 → PMK-1.2 ─┬─ PMK-1.3 ─┬─ PMK-1.6
                        │           └─ PMK-2.1 → PMK-2.2 (HITL)
                        └─ PMK-1.4 → PMK-1.5 → PMK-1.6
```

Saul's lane move (session `saul-lane-move`) now also waits on this plan: SAL-2.3 and SAL-3.1 depend on PMK-2.2.
Fallback if this slips: drop those two dependencies and flip Saul on the bake, which stays in place until PMK-2.1 merges.

## Breaking change safety

All additive: a new table, a nullable column, new routes, an optional bundle field, a new runtime step. PMK-2.1 removes the
bake, but nothing depends on it: Saul is still on the coding image until his flip, and he picks up shipwright from the new
mechanism. The reverse prune in PMK-1.3 covers the dangling registration the removal leaves on already-booted agents.

## Decision Log

- Release gate between PMK-1.3 and PMK-2.1: not added. The contract is additive, the pipeline is trusted, and PMK-2.2 checks
  the real outcome (a bake-less image deployed and booting).
- Marketplace config in a DB table, not an env var or a `plugin@source#ref` string: unique `(agentId, name)` makes two
  versions of one marketplace impossible, and nothing needs parsing.
- Baked list stored from a boot-time report, not read live: admin does not call into agent pods (agents report to admin).
- Specialists CLI/manifest change: dropped, since only Saul uses the shipwright marketplace.

## Out of scope

- Honoring `AgentPlugin.version` (the CLI has no per-plugin pin).
- A global marketplace catalog shared across agents.
- Automating a marketplace ref bump.
