# Admin API resources

Per-agent resources under `/agents/{id}/...` (see `agent-api.md` for auth).

## Tokens, chat credentials and chat-token usage

Three similarly named resources, three different things:

| Route | What it is | Who may call |
|---|---|---|
| `/agents/{id}/tokens` | Admin-API bearer tokens for the agent (`swt_v1_...`). Raw value returned once on create; only a hash is stored. | Per the generic agent-route auth. |
| `/agents/{id}/chat-credentials` | Chat-service tokens scoped to the agent, minted and revoked through admin. | `*` and `platform.ops` only — never the agent's own key. |
| `/agents/{id}/chat-tokens/daily` | Daily LLM token **usage** rollups (counts per model). Not a credential. | Per the generic agent-route auth. |

### Chat credentials

- `POST /agents/{id}/chat-credentials` with `{label}` → `201 {tokenId, rawToken, label, agentId}`.
  The raw token is returned once; admin never stores or logs it. The body is
  closed: an `agentId` field is a 400, so the token is always scoped to `{id}`
  and an unrestricted chat admin token cannot be minted here.
- `GET /agents/{id}/chat-credentials` → `{credentials: [{tokenId, label, agentId}]}` (no raw values).
- `DELETE /agents/{id}/chat-credentials/{tokenId}` → `204`. A token not scoped
  to `{id}` is a 404 and is not revoked.

Each mint and revoke writes one structured log line
`{event: "chat-credential.mint" | "chat-credential.revoke", agentId, tokenId, label, callerLabel}`.

The routes are off by default: they return 404 unless
`SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED=enabled`. They return 503 when the chat
service client is not configured (`SHIPWRIGHT_CHAT_SERVICE_URL` and
`SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN`).
