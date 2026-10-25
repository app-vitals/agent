# Admin API authentication

Every `/agents/*` (and `/accounts/*`) route sits behind one auth middleware
(`admin/src/api-auth.ts`). It accepts a bearer token or, when no `Authorization`
header is sent, a session cookie. A present-but-invalid bearer is a 401 and
never falls through to the cookie.

## Bearer scope kinds

`SHIPWRIGHT_ADMIN_API_KEYS` is a comma-separated list of `name:token:scope`
entries. The middleware exposes the result as `scope: {kind, agentId?}` beside
`isAdmin` and `caller` (and `callerLabel()` includes the kind in log lines).

| Scope in the key | Kind | `isAdmin` | Access |
|---|---|---|---|
| `*` | `admin` | true | Everything. |
| `<agentId>` (or a DB agent token) | `agent` | false | Routes of that one agent. |
| `platform.read` | `platform-read` | false | Every `GET`/`HEAD`; every mutating method is 403. |
| `platform.ops` | `platform-ops` | false | Everything `platform.read` has, plus the mutating routes in `PLATFORM_OPS_ROUTES`. |

`PLATFORM_OPS_ROUTES` (exported from `api-auth.ts`) is: `PATCH /agents/{id}`
(any field except `accountId`, which stays platform-admin only), `POST` and
`DELETE /agents/{id}/repos...`, `PATCH /agents/{id}/crons/{cronId}`,
`POST /agents/{id}/ask`, `POST` and `DELETE /agents/{id}/chat-credentials...`.
`PATCH /agents/{id}`, the `/repos` routes and `PATCH /agents/{id}/crons/{cronId}` are mounted;
`POST /agents/{id}/ask` and the `chat-credentials` routes are listed but not mounted yet, so
their own tasks only wire the handler.
Every other mutating route (env writes, agent create/delete/provision, tokens,
federation, accounts) stays 403 for both platform scopes.

### The colon rule

`parseAdminApiKeys` takes the **last** colon-separated segment as the scope and
everything between the name and the scope as the token. A colon inside a scope
name would therefore be read as part of the token, so scopes never contain one;
that is why the platform scopes are dot-spelled (`platform.read`, not
`platform:read`).

## Session cookies

The cookie is a JWT. `isAdmin` comes from the JWT's `isAdmin` claim (a missing
or non-true claim is non-admin), not from the presence of a cookie. Non-admin
cookies reach `GET /agents` (filtered to their memberships) and
`/agents/{id}/**` for agents they are members of; everything else is 403.
Cookies do not set `scope`.
