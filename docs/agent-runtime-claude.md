# Agent runtime: configuration and Claude sessions

Companion to [agent-runtime.md](./agent-runtime.md) (processes, boot order,
extension seam, health). This page covers runtime configuration, how `claude -p`
is spawned, and the entry points that trigger a Claude session.

## Configuration

`createConfig(agentHome)` (`config.ts`) reads `process.env` at call time and
returns `claude`, `shipwright`, `slack`, `alerts`, `owner`, `voice`, `chat`
and `paths` groups. `AGENT_HOME` defaults to `/data/agent-home` in `boot.ts`.

### Voice (STT/TTS)

`config.voice` is a boot-time snapshot, used only to validate `PIPER_VOICE` at
startup. Synthesis and transcription instead call `buildVoiceConfig()`
(`voice.ts`), which reads live `process.env` — the same approach as
`buildSlackAppConfig()` — so per-agent `ELEVENLABS_API_KEY` /
`ELEVENLABS_VOICE_ID` set via `PATCH /agents/{id}/envs` take effect within one
config-sync tick (≤ 60 s) without a restart. Per-agent env wins over
fleet-wide `admin.extraEnv` (config-sync overwrites the process value); when a
per-agent voice key is removed, `revertRemovedVoiceEnv` restores the fleet
value or unsets it, so the agent falls back to Piper on the next tick. Each
synthesis logs `[voice] TTS backend: elevenlabs|piper` (never the key).

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_MODEL`, `ANTHROPIC_FALLBACK_MODEL`, `ANTHROPIC_EFFORT_LEVEL` | `DEFAULT_ANTHROPIC_MODEL` | Passed to `claude` as `--model`, `--fallback-model`, `--effort`. |
| `SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS` | 25 min | Idle timeout: restarts on every stdout line. The one that fires in practice. |
| `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` | 1 h | Hard ceiling. |
| `SHIPWRIGHT_CHAT_SERVICE_URL`, `_TOKEN`, `SHIPWRIGHT_CHAT_POLL_INTERVAL_MS` | unset | Chat poller. |
| `SLACK_ALERT_CHANNEL`, `SLACK_OWNER_USER` | unset | Alert target and the owner used by cron delivery. |

Timeout overrides must be positive integers; anything else falls back to the
default so a bad value never disables the timeout. The environment can also
change after boot: each config sync calls `setLiveClaudeConfig` so the next
spawn picks up new model and tool settings without a restart.

## Running Claude (`claude.ts`)

`createRunClaude(...)` returns `run(message, sessionKey?, onProgress?, signal?,
extraEnv?, onEarlySessionId?)`, which spawns:

```
claude -p --output-format stream-json --verbose --permission-mode acceptEdits \
  --allowedTools <FLOOR_TOOLS + live allowedTools> --model ... [-r <sessionId>]
```

- **Tools.** `FLOOR_TOOLS` (Read, Write, Edit, Glob, Grep, TodoWrite, Skill) are
  always granted. Everything else, including Bash, comes from the agent's tool
  rows in the config bundle, so an agent with none gets no shell.
- **Serialization.** Calls with the same session key run one after another;
  different keys run concurrently.
- **Resume.** A stored session id is passed with `-r`. If a run fails, it is
  retried once, resuming the same session; the stored id is never cleared and
  no fresh session is started. Abort, idle-timeout and connection-lost
  failures are not retried (a ceiling timeout is). If the retry also fails,
  the original error is rethrown.
- **Errors.** `ClaudeRunError`, `ClaudeTimeoutError` and `ClaudeAbortedError`;
  `reportClaudeError` forwards to Sentry when it is configured.
- **Result.** `ClaudeRunResult` carries the reply text, session id, token usage
  and per-model usage (`dominantModel` picks the one to attribute).

Session ids live in `sessions.ts`: `createFileSessionStore(path)` is a JSON file
keyed by `channel:thread_ts` (`threadKey`), with a per-file write queue so
concurrent set/clear calls cannot lose writes. Entries expire after 7 days and
`startSessionPruner` sweeps every 6 hours. Chat sessions use the key
`chat:<threadId>` in a separate file (`paths.chatSessions`).

## Entry points that call Claude

| Source | File | Notes |
|---|---|---|
| Slack DM, mention, reaction | `slack.ts` | Bolt Socket Mode. Streams progress (`slack-progress.ts`, `progress-milestones.ts`), transcribes voice notes and synthesizes replies (`voice.ts`). Reports chat tokens via `chat-token-reporter.ts`. |
| Chat service | `chat-poller.ts` | Lists threads, claims the next unclaimed user message, runs it, posts the reply. A failure on one thread is logged and the others continue; a failed run must not leave the message claimed forever. |
| Cron | `cron-handler.ts` | `POST /cron` on the health server (and the internal scheduler). Body: `jobId`, `prompt`, optional `channel`, `user`, `silent`, `preCheck`. The prompt is prefixed `[Cron job: <id>] Current time: ...` (Pacific time). |

`POST /cron` returns 400 for bad JSON or a missing `jobId`/`prompt`, 422 for a
`ValidationError` (for example no delivery target), 503 if cron deps are not
wired, 500 for runner errors and 200 on success. Run outcomes go to the admin
API through `cron-run-reporter.ts`; failures are reported once
(`cron-failure-reporter.ts`).

### Reply markers (`markers.ts`)

`parseMarkers` strips these from the reply before it is posted and returns them
as actions: `[silent]`, `[upload:/abs/path]`, `[speak:text]`,
`[react:a,b]`, `[plan:url]`, `[skip-reason:text]`. A malformed marker is logged
and left in the text rather than crashing the run.
