# Agent runtime (`runtime/`)

`@app-vitals/agent-runtime` is the agent process: it boots in a container,
pulls its configuration from the admin API, and then turns Slack messages, chat
messages and cron fires into `claude -p` sessions. It imports no specialty
code; specialty behavior arrives through the extension seam below.

Canonical sources this doc does not repeat: `runtime/package.json` (the
`exports` map), `runtime/Dockerfile` (image layout and the base-image
contract), and the admin API docs (`docs/agent-api.md`).

## Two processes

| Process | File | Role |
|---|---|---|
| Entrypoint | `entrypoint-main.ts` → `entrypoint.ts` | Container `ENTRYPOINT`. One-shot startup, then spawns the server and exits with its exit code. |
| Agent server | repo-root `index.ts` → `boot.ts` (`startAgent`) | Long-lived. Owns the single health server, Slack, the chat poller and the cron scheduler. |

The entrypoint must not start a health server: the server process binds the
port (`DEFAULT_HEALTH_PORT`, 3459) and a second listener would crash it with
`EADDRINUSE`.

### Entrypoint sequence

`runEntrypoint(deps)` takes every side effect as an injected dependency, so
tests pass doubles and production wires real ones in `entrypoint-main.ts`.

1. Require `SHIPWRIGHT_AGENT_ID`, `SHIPWRIGHT_API_URL`, `SHIPWRIGHT_AGENT_API_KEY`
   (or `--agent-id`, `--api-url`, `--api-key`, parsed by `cli-args.ts`). Missing
   values log a fatal line and exit 1.
2. Fetch the config bundle (`GET /agents/:id/config`, via
   `shipwright-runtime-client.ts`).
3. Apply the bundle's `env` to `process.env` through `applyEnvToProcess`
   (`anthropic-federation-guard.ts` skips the Anthropic credential keys when
   workload-identity federation is active). `SHIPWRIGHT_AGENT_TYPE` is set from
   the bundle's `specialty`.
4. Symlink `~/.claude` to `$AGENT_HOME/dot-claude` (`ensureDotClaudeSymlink`).
5. GitHub auth (`setup-github-auth.ts`, below).
6. `runMiseStartup`: install the workspace's mise tools and put the shims on `PATH`.
7. `installPlugins` with any marketplaces baked into the image under
   `/opt/shipwright/marketplaces` (`BAKED_MARKETPLACES_ROOT`). Remote marketplaces
   from the config bundle are deferred to the boot sequence (step 3 below).
8. Spawn `bun run index.ts` with inherited stdio.

Steps 2 to 8 race a deadline (180 s, overridable with
`SHIPWRIGHT_STARTUP_TIMEOUT_MS`). `mise install` on a cold node can be slow, so
keep the default aligned with the startup probe in `admin/src/agent-manifest.ts`.

## Boot order (`boot.ts`)

`startAgent(extensions)` runs these in order. The health server comes first so
kubelet probes stay green during setup.

1. `ensureAgentHome` creates `workspace/` (with `state/`, `repos/`,
   `worktrees/`, `.claude/`), `mise/`, and seeds the `*.md.template` files from
   `runtime/workspace/` (or from the resolved specialty type's templates when
   available, see `resolveTemplatesDir`). Seeding never overwrites an existing file.
2. Health server.
3. `runMiseStartup` and `installPlugins` (baked marketplaces and any default plugins
   from specialty templates).
4. First config sync (awaited), then repeated every 60 s: fetch the bundle,
   re-apply env, update the live Claude config, repos and policy refs, reconcile
   remote marketplaces from the bundle, install agent plugins (and uninstall
   ones removed or disabled since, ledger-scoped; see
   [agent-ops.md](./agent-ops.md#removal-and-the-ledger)), clone newly
   configured repos, and start Slack if credentials have appeared.
5. `reconcileTemplate` and `reconcileSystemCrons`, best effort and non-fatal.
   `reconcileTemplate` applies the agent's merged template (ATP-2.2, via
   `shipwright-runtime-client.ts`) from the admin API; this runs first so any
   template-derived crons and tools are in place before system-cron reconciliation.
   Template `marketplace` items are reconciled into the agent's rows by the admin
   reconcile (see [agent-ops.md](./agent-ops.md#template-managed-marketplaces)) and
   then installed through the same config bundle as remote marketplaces.
   A failure (an admin without the route, or a transient error) is non-fatal and
   never blocks boot.
6. Cron sync loop (60 s; `reconcileCronTasks()` in `cron-sync.ts` unschedules removed jobs
   and reschedules any job whose schedule, prompt, channel, user, silent, preCheck or
   dispatch kind changed) and the periodic reconciler tick.
7. Slack Socket Mode app, chat poller, session pruner.

Three hooks wired in `boot.ts` ride on the config sync and are gated by the
bundle's `features` object (held in `agent-features-ref.ts`; absent means all
off):

- `transcriptUploader` uploads a redacted cron-run transcript after
  `completeRun` when `features.transcriptUpload` is true. The same deps back a
  second uploader exposed to extensions as `AgentExtensionContext.transcriptUploader`,
  gated by `features.loopTranscriptUpload` instead.
- `repoAccessProbe` probes per-repo GitHub access for the installations
  reporter when `features.repoAccessCheck` is true.
- `createRunNowHonourer` runs a cron job once on each sync tick when the admin
  has stamped a fresh `runRequestedAt`; jobs classified as `loop` go through
  `extension.dispatchLoop`.

See `agent-key-files.md` for each module's contract.
8. Graceful shutdown on `SIGTERM`/`SIGINT`.

Slack is optional. With no `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` the agent runs
chat-only, and `slack-startup.ts` (`startSlackIfPossible`) starts Bolt exactly
once whenever a later config sync supplies the credentials.

## Configuration, running Claude and entry points

Moved to [agent-runtime-claude.md](./agent-runtime-claude.md):
[configuration](./agent-runtime-claude.md#configuration) (`createConfig`, voice,
timeouts), [running Claude](./agent-runtime-claude.md#running-claude-claudets)
(`claude.ts`, sessions) and the
[entry points that call Claude](./agent-runtime-claude.md#entry-points-that-call-claude)
(Slack, chat, cron, reply markers).


## Extension seam (`agent-extension.ts`)

The runtime calls an `AgentExtension` at fixed points; every hook is optional.

| Hook | When |
|---|---|
| `onConfigSync(bundle)` | After each successful config sync. |
| `periodicPasses` | Each reconciler tick; one failing pass is logged and does not stop the rest. |
| `onCronJobs(jobs)` | Each cron sync, before classification. |
| `classifyCronJobs(jobs)` | Chooses which jobs are scheduled, and whether each dispatches as `loop` or `generic`. |
| `dispatchLoop(loopCronId)` | Fires a job classified as `loop`. |

`composeExtensions` merges factories passed to `startAgent`. With none, all
cron jobs are generic and there are no periodic passes. This file must not
import a specialty module; only `index.ts` wires one in.

## GitHub auth and repos

- `github-app-auth.ts` caches installation tokens and refreshes them early.
  `github-installations.ts` tracks the installations, and
  `github-installations-reporter.ts` reports them to the admin API.
- `gh-token-files.ts` writes the token to a file that
  `scripts/bin/git-credential-shipwright.sh` reads through `$GH_TOKEN_FILE`;
  a PAT (`GH_TOKEN`) is the fallback when no App is configured.
- `spawn-env.ts` adds `SHIPWRIGHT_GH_OWNER` to loop and cron spawns so the `gh`
  wrapper picks the matching installation token. DM spawns get no hint.
- `sync-config-clone.ts` clones repos that appear in the config, using
  `gh repo clone` through an async spawn so health probes are not blocked.
- `worktree-reaper.ts` force-removes `worktrees/<repo>-<branch>` directories
  older than the configured cleanup age, with no GitHub or task-store calls.

## Health (`health.ts`)

`GET /health` returns `{ok, slack, claudeCodeVersion}`. It returns 500 only when
the Slack socket has been down longer than `SLACK_DOWN_GRACE_MS` (90 s). That
is the self-heal path: a sustained wedge trips the liveness probe and the pod
restarts. Reconnect blips and the not-yet-connected startup window stay 200.

## Tests

Tests sit beside the code as `*.unit.test.ts`, `*.integration.test.ts` and
`*.smoke.test.ts`; shared fixtures are in `runtime/fixtures/`. The
Dockerfile's module-resolution guard and base-image contract are covered by
`base-image-contract.smoke.test.ts`; change them together. That file also
guards that the runtime stage copies `node_modules` from the production-only
`prod-deps` stage (`bun install --frozen-lockfile --production`), so
devDependency-only packages (handlebars, typescript, semantic-release, biome,
a nested npm) never ship in the image while the Prisma client stays. Run single unit files with
`bun test runtime/<file>`; integration and smoke files need
`--config=bunfig.integration.toml` or `--config=bunfig.smoke.toml`.
