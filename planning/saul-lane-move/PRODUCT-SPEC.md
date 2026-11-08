# Plan: Move Saul from the `coding` lane to the `specialist` lane (same agent, new image)

## Context

Saul (agent `cmrnw6im5000eaz01e6ap6lxc`, Slack `@Saul` `U0BJQHVA06L`) is App Vitals' marketing/podcast agent.
His **source definition already moved** from `vitals-os` to `app-vitals/specialists` on 2026-10-22
(vitals-os#6699): `specialists/specialties/podcast/specialty.ts`, `specialists/specialties/marketing/specialty.ts`,
`specialists/plugins/podcast-publisher/` (0.1.12), `specialists/plugins/marketing/` (persona names him).
Nothing Saul-specific is left in vitals-os except shared runtime he *calls* (podcast API + `saul-podcast` key,
growth syncs, Bosun→Saul `ask.allowlist` keyed by agent id) and the `image/specialists/` lane that layers the private
`vitals-os` time-tracking plugin onto the specialists base image for *every* specialist (Bosun included).

What never moved is the **running agent**. His Shipwright record still says `specialty: coding` (the specialists
repo rule file records this as "hand-provisioned coding-type agent, by decision"; `planning/specialists/PLAN.md:8`
lists "migrating Saul" as the deferred follow-up). Because images are resolved **per specialty, never per agent**
(`agent/admin/src/agent-image-map.ts` ← `SHIPWRIGHT_AGENT_IMAGES` ← `vitals-os/infra/helm/shipwright-deploy/values-prod.yaml:519-536`),
he runs `coding-agent:coding-agent-v0.4.6-79dab7a`, whose baked `vitals-os` marketplace has only the `vitals-os`
plugin. Result: his `marketing@vitals-os` and `podcast-publisher@vitals-os` installs fail every minute (Bosun: the only
pod in the fleet with failures) and he is stuck on a cached podcast-publisher 0.1.10 that never reads
`PODCAST_SHORTS_SCHEDULING` (specialists#265 / 0.1.12).

**Goal (Dave):** same agent id, Slack identity, crons, tools, repos, env, memory and workspace — **only the image
changes** — with no interrupted run. Re-creating Saul and baking his plugins into the coding image are both ruled out.

**Blocker:** `PATCH /agents/:id` does not accept `specialty` (`agent/admin/src/agents-api.ts:623`; schema
`openapi-schemas.ts:41` — the key is silently dropped). No other supported path; no psql.

**Participants:** Bosun (`#ops-bosun` thread `1794171464.124549`) and Saul (`#growth` thread `1794153343.527149`)
both answered read-only questionnaires on 2026-11-08; their facts are in the table below. Saul waits for a go.

## Established facts (cited)

| Fact | Source |
|---|---|
| Image = `resolveImage(specialty)`: specialty entry → `default` → `SHIPWRIGHT_AGENT_IMAGE`. Only `coding` has an entry; everything else gets `vitals-os-specialist-agent-v0.4.6-298563a-b0.50.0` | `agent/admin/src/agent-image-map.ts`; `values-prod.yaml:519-536`; `gitops/docs/ops-map.md:20-37` |
| PATCH only rebuilds the pod for `accountId` / `podServiceAccountName` (`reconcileAgentAfterAccountChange` in `agent-account-assignment.ts`, wired at `agents-api.ts:1781`; it already passes `specialty` into the full reconcile) | `agents-api.ts:1781-1798`; Bosun |
| `agent-provisioner.ts` needs no change: the Deployment manifest differs only by image (`agent-manifest.ts:473` takes no specialty input); chart sets no per-lane env/secrets | Bosun |
| Agent Deployments: `strategy: Recreate`, RWO PVC, 120s grace → every image change is one pod replacement, a few minutes dark | `agent-manifest.ts:516,230,544`; confirmed live |
| **On SIGTERM the runtime stops crons + Slack and exits without waiting for running Claude processes** → an in-flight job is killed | `runtime/boot.ts` ~930 (Bosun) |
| Runtime boot calls `POST /agents/:id/crons/reconcile` **every boot**; `reconcileSystemCrons` deletes every `system=true` cron not in the manifest (cascade-deletes run history). `specialist` manifest: `crons: []`, `plugins: []`, tools Bash/WebSearch/WebFetch/Agent | `agent-cron-jobs.ts:476-517`; `runtime/boot.ts:666-668`; `agent-types/specialist/manifest.yaml` |
| Tools/plugins rows are written only at create (`agents.ts:954-957`) and never re-synced; loop dispatch keys off cron *names*; no `specialty` use in metrics, Slack routing or memory service. Other `specialty` consumers: workspace template choice (`runtime/setup.ts:93-135`, rewrites `SPECIALTY.md`), required-env report (`agents.ts:420`), config payload `SHIPWRIGHT_AGENT_TYPE` (`api.ts:353`), admin UI display | Bosun |
| Saul's live record: plugins `marketing@vitals-os` (version null), `podcast-publisher@vitals-os` (0.1.0 pin — ignored, runtime installs unversioned), `shipwright@shipwright`; ~10 coding system crons, all disabled except **`learn-dream`**; 7 unnamed + 7 named user crons → `#growth`; `podcast:podcast-resume` (*/5); 6 tool rows; repos goals/shipwright/vitals-os/marketing-site; no `MEMORY_*`/`VITALS_PERSONA_*` env | admin GETs (read-only, today) |
| **Everything durable is on the PVC `/data/agent-home`** (workspace/state 7.5 GB, repos incl. uncommitted `goals/drafts/podcast-ep043.json`, memory files, sessions, mise python+ffmpeg, `dot-claude` = `~/.claude` incl. plugin cache, `installed_plugins.json`, registered marketplaces). PVC name `vitals-os-agent-{name}-home` is derived from agent name, **not** specialty → same volume after the swap | Saul; `agent-provisioner.ts:859-861`; `values-prod.yaml:518` |
| Persona files (`CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, `VOICE.md`, `TEAM.md`) seeded write-if-absent → untouched. `RUNTIME.md`/`SPECIALTY.md` are rewritten each boot from the specialty template (SPECIALTY.md changes coding→specialist content; Saul's CLAUDE.md does not include it) | Saul; Bosun |
| Env he depends on is lane-independent: `VITALS_OS_API_URL` is `ENV` in **both** `vitals-os/image/coding/Dockerfile:24` and `image/specialists/Dockerfile:35`; `WHISPER_SERVICE_URL`, `SHIPWRIGHT_*`, `AGENT_HOME`, repo/worktree dirs come from `agent-manifest.ts` + chart for every agent | code grep |
| Image diff: both build on `ghcr.io/app-vitals/agent:1.2.5` (gh, git token wrappers at `/app/scripts/bin`, jq, node, bun, mise, Playwright chromium-headless-shell). Coding layer adds only: `/app` shipwright marketplace (`SHIPWRIGHT_REPO_ROOT=/app`), coding runtime entry (loop crons — all disabled on Saul), coding templates. Specialist image adds `kubectl`. Neither has system ffmpeg/yt-dlp/python3 (Saul's come from mise on the PVC) | Bosun; `agent/runtime/Dockerfile:212-229` |
| **`shipwright@shipwright` on Saul:** `learn-dream` cron, `slack-say` (14 uses/30d), `prd`/`plan-session`/`dev-task` named in `marketing-daily-ops`. Task store/admin API via plain `curl`. Specialist image has no shipwright marketplace → silent install failure | Saul; Bosun |
| Saul's PVC has the `shipwright` marketplace **registered as directory `/app`**; on the specialist image `/app` has none (Bosun's 11-04 cache-miss). Bosun's fix (GitHub source, unpinned `main`) persisted on his PVC | Bosun |
| Marketplace name `vitals-os` is load-bearing for plugin rows; likewise `shipwright` must stay `shipwright` | `specialists/image/marketplace-name.content.test.ts`; Bosun |
| Restart ordering: landing the platform PR restarts no agents; a default-image pin restarts only default-image agents (today: Bosun only); a **coding** pin PR merging before the window would restart Saul once more | Bosun |
| Saul idle window: Sun 21:00Z – Mon 03:00Z; avoid 05:30–09:30Z and 13:00–15:00Z; swap before Monday's episode run. EP043 parked at `scheduling_shorts` | Saul |

## Decisions (Dave, 2026-11-08)

1. **Keep `shipwright@shipwright` working** by baking the shipwright marketplace into the specialist lane (PR 2).
2. **Coding loop crons are deleted** — "specialist agents should never run those coding crons". The disabled
   `shipwright-*` system crons go with the specialty change. `learn-dream` (enabled, a learning cron not a loop) is
   converted to a user cron so it keeps running with its history.
3. **Lane flip only.** No CLI provisioning, memory, persona composer or `marketing:*` cron reconciliation here; that
   stays the separate "Saul migration" follow-up in `specialists/planning/specialists/PLAN.md`.

## Approach

Two code PRs, then one supervised pod swap. Both PRs are deployed **before** the swap so Saul restarts exactly once.

### PR 1 — app-vitals/agent: supported `specialty` change on an existing agent

Files (per Bosun + my read): `admin/src/openapi-schemas.ts` (`PatchAgentBodySchema` + response), `admin/src/agents-api.ts`
(route doc :623, handler ~1667), `admin/src/agents.ts` (`updateSelfHosted` :471 — add `specialty`),
`admin/src/agent-account-assignment.ts` (add `reconcileAgentAfterSpecialtyChange`, a copy of
`reconcileAgentAfterAccountChange`), `admin/src/agent-cron-jobs.ts` (guard), `lib/admin-types.ts`, admin UI agent page
(show/edit specialty, platform-admin only), `docs/specialties.md` (also fix the stale "one shared image" sentence).
Tests alongside each (`*.unit.test.ts`, `*.integration.test.ts`). `agent-provisioner.ts` untouched.

Behaviour:
1. `PATCH /agents/:id { specialty }` — platform-admin only (403, same gate as `accountId`); 422 unless
   `specialtyRegistry.tryGetManifest(new)` resolves; no-op when unchanged; audit log line (ids/names only).
2. **Cron guard in `reconcileSystemCrons` itself** (it runs every boot): an orphan `system=true` cron that is
   `enabled=true` is **converted to a user cron** (`system=false`, id and `AgentCronRun` history kept) instead of
   deleted; disabled orphans are deleted as today. This protects any future specialty change, not just Saul's.
3. After the DB write the handler calls `reconcileSystemCrons(agentId)` immediately (so the cron outcome is applied
   before the new pod boots) and then `reconcileAgentAfterSpecialtyChange` → full workload reconcile → Deployment
   re-patched to `resolveImage(newSpecialty)` → `Recreate`. Returns the reconcile warning string as today.
4. **Preview**: `GET /agents/:id/specialty-change-preview?to=<specialty>` returning
   `{ imageBefore, imageAfter, templatesDir, crons: { kept, converted, deleted }, toolsUnchanged: true, pluginsUnchanged: true }`.
   This is the "cron-diff dry run" `shipwright/planning/specialist-agent-type/PLAN.md:67` already called for.
5. Rollback path uses the same route (`specialty: "coding"`); the preview must show that `learn-dream` would then be
   re-created as a system cron next to the converted user cron — document that rollback deletes the user copy first.

Platform API change → Dan approves. Deploys via the admin image pin (`gitops/apps/shipwright.yaml` targetRevision ←
vitals-os `gitops-deploy.yml`); confirm the prod admin runs this version **before** the PATCH (`GET /agents/:id` response
or admin version endpoint). Restarts no agents.

### PR 2 — vitals-os `image/specialists/`: bake the `shipwright` marketplace into the specialist lane

Home: `vitals-os/image/specialists/Dockerfile` (+ `merge-marketplace.ts` tests, `baked-marketplace.smoke.test.ts`).
My call, not Bosun's (he suggested `specialists/image/Dockerfile`): the specialists repo's hard rule is "depend on the
agent module, not on Shipwright; never the `shipwright-agent` image", and the vitals-os layer already pulls the pinned
`shipwright-agent` for the coding lane (`image/coding/Dockerfile`), so the second `COPY --from=` lives there.

Change: `COPY --from=<pinned shipwright-agent> /app/.claude-plugin /opt/shipwright/marketplaces/shipwright/.claude-plugin`
and `/app/plugins/shipwright → /opt/shipwright/marketplaces/shipwright/plugins/shipwright` (chown 1000:1000, same as
the `vitals-os` marketplace). Marketplace name stays `shipwright`. Pin the shipwright-agent tag the same way the coding
lane does (build arg), so the specialist lane's shipwright plugin version is explicit. Also:
- `docs/architecture-infrastructure.md:86-96` stale default-image name; root `.claude-plugin/marketplace.json` lists
  non-existent plugins — fix in the same PR.
- Root workspace `CLAUDE.md:34` claims `vitals-os/plugins/vitals-os` is a stale copy — it is the only copy since
  specialists#230; fix the sentence (workspace file, not a repo).

Rolls out as a default-image pin PR → restarts Bosun only (harmless: no plugin row). Must be merged and pinned before
the swap.

### Cutover (HITL, browser/API only — no kubectl)

Pre-flight (after PR 1 is live on prod admin and PR 2's pin is deployed):
1. Snapshot Saul's record via admin API: `GET /agents/:id`, `/crons`, `/plugins`, `/tools`, `/envs` (names only).
   Read the 7 unnamed cron prompts for any binary outside the base image (Bosun's one unchecked item).
2. Run the preview endpoint; expected: `imageAfter` = current default pin, `converted` = [`learn-dream`],
   `deleted` = the disabled `shipwright-*` set, tools/plugins unchanged. Post the JSON in `#ops-bosun` for Bosun.
3. Confirm no coding pin PR is about to merge (it would restart him early).
4. Ask Saul in `#growth` to confirm no episode run is active and EP043 still parked; ask him to hold.

Swap (Sun 21:00Z–Mon 03:00Z, **before** Monday's episode run):
5. Wait for a `podcast-resume` tick to finish (every 5 min) and confirm no Claude session is running (admin agent
   page / `GET /agents/:id` activity, or ask Saul "are you idle right now").
6. `PATCH /agents/cmrnw6im5000eaz01e6ap6lxc { "specialty": "specialist" }` — Dave, from admin UI/API.
7. Watch the agent page / Argo for the Deployment to come back on `vitals-os-specialist-agent-…`. Expect a few minutes dark.
8. Saul confirms in `#growth`: `ls ~/.claude/plugins/cache/vitals-os/podcast-publisher/` lists `0.1.12`;
   `/marketing:*`, `/podcast-publisher:*`, `/shipwright:slack-say` resolve; `claude plugin marketplace list` shows
   `shipwright` → `/opt/shipwright/marketplaces/shipwright` (not `/app`; if it still says `/app`, he re-adds it:
   remove + add the baked dir); no install failures in boot log; user crons intact; `learn-dream` present as user
   cron; then he removes his hand-edit in the 0.1.10 cache dir.
9. Bosun fleet check: plugin-install failures across all pods = 0; Saul's Deployment image matches the default pin.

Rollback: `PATCH { "specialty": "coding" }` (delete the converted `learn-dream` user cron first, see PR 1 point 5);
image follows automatically, one more `Recreate`. If PR 1 itself misbehaves: `git revert` the admin pin in gitops.

## Out of scope / follow-ups (recorded, not done here)

- CLI-provisioning Saul (memory key, persona composer, `marketing:*` cron reconciliation, marketplace rename
  `vitals-os`→`specialists`) — the specialists "Saul migration" project.
- `GITHUB_PAT_TRAFFIC` 401 on vitals-os-api (Saul's nightly GitHub sync) — unrelated.
- The 25s Short (Arm B) upload for 11-09 — studio-side, unrelated.
- Runtime SIGTERM handling that kills in-flight Claude jobs (`runtime/boot.ts` ~930) — worth its own platform task.

## Verification

- PR 1: unit tests — schema accepts `specialty`, 403 for non-admin, 422 for unknown specialty, no-op when unchanged;
  integration tests — enabled orphan → user cron with history preserved, disabled orphan deleted, PATCH invokes the
  workload reconcile with the new image, preview endpoint snapshot. `bun run lint && bun run typecheck && bun test`
  in `agent/`, plus `check:boundary`, `check:config-docs`.
- PR 2: `image/specialists` tests assert `/opt/shipwright/marketplaces/shipwright/.claude-plugin/marketplace.json`
  exists and names `shipwright`; `build-lane-image.yml` smoke-check + parity gate pass; Bosun boots clean on the new pin.
- Cutover: steps 7–9 are the acceptance test. Monday's episode run posts the 0.1.12 "▸ Shorts scheduling off …"
  line (not the hand-edit); Tuesday's `#growth` daily pass posts; `learn-dream` shows a run in cron runs; Bosun's
  morning digest shows no credential/plugin errors for Saul.
