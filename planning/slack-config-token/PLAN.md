# Plan: slack-config-token

Store the Slack App Configuration refresh token in agent admin settings so create / sync / delete of Slack apps no longer needs a pasted `xoxe.xoxp-` token. Requested by Dan. Repo: `app-vitals/agent` (docs follow-up in `app-vitals/shipwright`).

## Slack facts (verified)

Docs: config access token expires 12h; `tooling.tokens.rotate` takes the `xoxe-1-` refresh token and returns a new access token + new refresh token; no scopes needed; manifest APIs need `app_configurations:write`.

Observed on a real token (Dan, 2026-11-16):
- Rotating returns a new refresh token every time and **revokes the access token issued with the refresh token that was used** (`token_revoked`).
- Old refresh tokens are **not single-use**: replaying refresh A after B and C existed still returned `ok:true` (returned the current chain refresh token). Lifetime / grace period unknown (tested minutes, not hours).
- Access token lifetime 12h (`exp - iat`).
- Always persist the newest refresh token; do not rely on old ones.

Consequence: lockout from a double rotate is unlikely, but a second rotate revokes the first caller's access token. Rotation must still be serialized, the access token cached in the DB so replicas share it, and a `token_revoked` / `invalid_auth` on a manifest call must trigger one forced rotate + retry.

## Design

**Scope — follow `AgentTemplate`.** `SlackConfigToken` has a surrogate `id`, a nullable `accountId` FK (cascade), `null` = deployment-wide default. At most one row per scope; Prisma cannot express partial unique indexes, so they are hand-written in the migration (`accountId` set: unique; `accountId` NULL: unique) with a schema comment like `AgentTemplate`'s. Resolution for an agent: its account's row, else the deployment-wide row, else none (paste fallback).

**Columns:** `refreshTokenEncrypted` (required), `accessTokenEncrypted` + `accessTokenExpiresAt` (nullable cache), `slackTeamId`, `slackUserId`, `lastRotatedAt`, `lastError`, timestamps.

**Service (`SlackConfigTokenService`)** — modelled on `GitHubEnterpriseAppService`: strict crypto (`makeStrictTokenCrypto`), save refuses without `SHIPWRIGHT_ENCRYPTION_KEY`, reads return metadata only (`configured`, `lastRotatedAt`, team/user, `lastError`), only server-side `getAccessToken()` decrypts. Errors never contain token material.

**Resolver `getAccessToken(scope)`:** cache hit if > 10 min left. Otherwise `$transaction`: `SELECT … FOR UPDATE` on the row (pattern at `account-members.ts`), re-check cache (another caller may have rotated), call `tooling.tokens.rotate`, write new refresh + access token + expiry, commit, return the access token. Persist-before-return. `invalid_refresh_token` records `lastError` and surfaces a "regenerate the token in Slack" error. A `forceRotate` option is used for the one retry after `token_revoked` / `invalid_auth` from a manifest call.

**Rotate client:** `rotateConfigToken(refreshToken)` added as a new small interface beside `HttpSlackProvisioningClient` — not a new required member of `SlackProvisioningClient` (additive-only rule for exported types).

**Settings UI:** `/admin/settings/slack-config-token`, next to GitHub Enterprise and in the settings nav; scope handling mirrors `admin-ui-templates.ts` (`resolveActor` / `resolveScope`, `?accountId=`). Platform admins manage the deployment-wide row and any account's; **account owners manage their own account's row**. Actions: save (validates by rotating once, stores the returned pair), clear, "rotate now". Shows configured / last rotated / last error only.

**Flows:** new-agent form (`admin-ui.ts` POST `/admin/agents`), `slack-provisioning-service.ts` `startConnect`, Sync Manifest, connect-slack, agent deletion (`agent-deletion.ts`, `agents-api.ts`). When a stored token resolves, `xoxpToken` becomes optional; a pasted token still wins (override / fallback).

**Unchanged:** the `xapp-` app-level token paste after OAuth callback (no API to mint it); the bot-token OAuth install step.

## Breaking-change scan

All additive: new table, new routes, new service, optional `xoxpToken` params. Safe to deploy standalone: yes (every task).

## Tasks

| Task | Title | Depends on | Layer | Hours | Model |
|---|---|---|---|---|---|
| SCT-1.1 | feat: add SlackConfigToken table and storage service | — | Database | 4 | sonnet |
| SCT-1.2 | feat: add tooling.tokens.rotate client | — | Shared | 2 | haiku |
| SCT-2.1 | feat: add serialized Slack config access-token resolver | 1.1, 1.2 | Background | 6 | opus |
| SCT-3.1 | feat: add Slack config token settings page | 1.1, 2.1 | Frontend | 6 | sonnet |
| SCT-4.1 | feat: use stored Slack config token in create, sync and delete flows | 2.1 | API | 6 | sonnet |
| SCT-5.1 | docs: document stored Slack config token in agent docs | 3.1, 4.1 | Shared | 2 | haiku |
| SCT-5.2 | docs: update site docs for stored Slack config token | 5.1 | Shared | 2 | haiku |

```
[START]
  ├─ SCT-1.1 (no deps)
  └─ SCT-1.2 (no deps)
        └─ SCT-2.1 (needs 1.1, 1.2)
              ├─ SCT-3.1 (needs 1.1, 2.1)
              └─ SCT-4.1 (needs 2.1)
                    └─ SCT-5.1 (needs 3.1, 4.1)
                          └─ SCT-5.2 (needs 5.1)
```

## Decision Log

- Scope model: followed `AgentTemplate` (nullable `accountId`, hand-written partial unique indexes) per Dan.
- Authorization: account owners can set their own account's token; platform admins manage the default and any account — per Dan.
- Rotation lock: row lock (`FOR UPDATE`) held across the Slack call — per Dan.
- Agent deletion uses the stored token — per Dan.
- Dropped the planned HITL "verify rotate semantics" task: Dan ran it against a real token (findings above), so no task is needed.
- SCT-5.2 is in `app-vitals/shipwright` (site docs live there); it depends on SCT-5.1 only, since docs describe behavior, not a package export.
