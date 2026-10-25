# Agent Admin API — Agent Resources

Per-agent resource endpoints for the [Agent Admin API](./agent-api.md): the allowed-tools list, API tokens, plugins, chat token usage, and the GitHub installations snapshot. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config, and [`docs/agent-api-ops.md`](./agent-api-ops.md) for cron jobs and cron runs.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

---

## Tools (allowed-tools list)

The allowed-tools list controls which Claude Code tools the agent can call.

### Add tool

```
POST /agents/:id/tools
```

Body: `{ pattern: string }`. Pattern is a glob or exact tool name (e.g. `"Read"`, `"Bash"`, `"mcp__*"`). The tool is created enabled. Returns `201`.

### List tools

```
GET /agents/:id/tools
```

Returns `{ tools: AgentTool[] }` where each entry has `id`, `pattern`, and `enabled`.

### Update tool

```
PATCH /agents/:id/tools/:toolId
```

Body: `{ enabled: boolean }` (required). Returns the updated tool.

### Delete tool

```
DELETE /agents/:id/tools/:toolId
```

Returns `204`.

---

## API tokens

Per-agent bearer tokens for scoped API access. The raw token is returned once at creation; only its SHA-256 hash is stored.

### Create token

```
POST /agents/:id/tokens
```

Body (optional): `{ label?: string }`. Returns `201` with `{ token: { id, agentId, label, createdAt, revokedAt }, rawToken }` where `rawToken` is the raw value — save it immediately.

### List tokens

```
GET /agents/:id/tokens
```

Returns `{ tokens: AgentToken[] }` (metadata only — the hash is never returned). Raw token values are never returned after creation.

### Revoke token

```
DELETE /agents/:id/tokens/:tokenId
```

Soft-deletes the token (sets `revokedAt`). Returns `204`.

---

## Plugins

Plugins are Claude Code marketplace plugins installed for the agent.

### Install plugin

```
POST /agents/:id/plugins
```

Body: `{ name: string, version?: string | null }`. The plugin is installed enabled. Returns `201`.

### List plugins

```
GET /agents/:id/plugins
```

Returns `{ plugins: AgentPlugin[] }`.

### Update plugin

```
PATCH /agents/:id/plugins
```

Query param: `name` (required). Body: `{ version?: string | null }`. Returns the updated plugin.

### Remove plugin

```
DELETE /agents/:id/plugins
```

Query param: `name` (required). Returns `204`.

---

## Chat token usage

Daily aggregate of Slack chat session token usage.

### Record daily usage

```
POST /agents/:id/chat-tokens/daily
```

Atomic upsert — accumulates usage into the existing rows for `(agentId, date, model)` tuples if they exist. When a single day spans multiple models (e.g., agent tools using different Claude versions), supply a `modelBreakdown` array to split usage by model.

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `date` | yes | `YYYY-MM-DD` |
| `modelBreakdown` | yes | Array of per-model usage entries. Each entry: `{ model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd: number }` |

Returns an array of updated daily rows (one per model in the breakdown).

### Chat token stats

```
GET /agents/chat-tokens/daily/stats
```

Self-serve variant: `GET /agents/{id}/chat-tokens/daily/stats` returns the same shape scoped to one agent, with no admin scope required (agent's own token, admin, or member session).

Admin-only. Aggregated chat-token daily stats across all agents broken down by model. Query params: `from` and `to` (optional `YYYY-MM-DD` date strings).

Returns `{ totals, byAgent, byModel, daily }` where each aggregate includes `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `costUsd`.

---

## GitHub installations snapshot

One row per agent, holding the agent's most recently reported GitHub App installations. Replace-all: each `PUT` overwrites the stored list wholesale, so an installation absent from the latest body is dropped. The row is deleted when the agent is deleted. Auth: an admin key/session, or the agent's own bearer token (a token owned by a different agent gets `403`).

### Put snapshot

```
PUT /agents/:id/github-installations
```

Body (closed schema — any unknown field, such as a token, is rejected with `400`):

| Field | Required | Description |
|-------|----------|-------------|
| `reportedAt` | yes | ISO timestamp when the agent reported this list |
| `installations` | yes | Array of `{ owner: string, installationId: positive integer, state: string (max 50), lastError?: string \| null (max 500, sanitized) }`; each entry is also closed |

Returns `200` with:

```json
{
  "snapshot": {
    "id": "string",
    "agentId": "string",
    "reportedAt": "ISO timestamp",
    "installations": [{ "owner": "string", "installationId": 123, "state": "string", "lastError": "string (optional)" }],
    "createdAt": "ISO timestamp"
  }
}
```

### Get snapshot

```
GET /agents/:id/github-installations
```

Returns `200` with the latest snapshot in the same `{ snapshot: { ... } }` format, or `404` if the agent has never reported one.
