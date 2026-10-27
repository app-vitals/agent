{{/*
agent-platform.publicHost — the externally-reachable hostname for whichever
networking path is active: networking.ingress.host when networking.type=
ingress, networking.gateway.host when networking.type=gateway, and "" for any
other networking.type (ClusterIP/NodePort/LoadBalancer have no single public
hostname the chart can name). GROUNDWORK: a follow-up task can use this to
assemble admin.appBaseUrl-style values automatically instead of requiring a
manual override.
*/}}
{{- define "agent-platform.publicHost" -}}
{{- if eq .Values.networking.type "ingress" -}}
{{- .Values.networking.ingress.host -}}
{{- else if eq .Values.networking.type "gateway" -}}
{{- .Values.networking.gateway.host -}}
{{- end -}}
{{- end }}

{{/*
agent-platform.publicScheme — "https" when TLS terminates on the active networking
path (networking.type=ingress with networking.ingress.tls.enabled, OR
networking.type=gateway with tls.certManager.enabled), else "http". Pairs with
agent-platform.publicHost for a follow-up task to assemble a full public base URL.
*/}}
{{- define "agent-platform.publicScheme" -}}
{{- $https := false -}}
{{- if eq .Values.networking.type "ingress" -}}
{{- $https = .Values.networking.ingress.tls.enabled -}}
{{- else if eq .Values.networking.type "gateway" -}}
{{- $https = .Values.tls.certManager.enabled -}}
{{- end -}}
{{- if $https }}https{{- else }}http{{- end -}}
{{- end }}

{{/*
agent-platform.admin.appBaseUrl — the resolved public base URL for the admin
service (used to set SHIPWRIGHT_ADMIN_APP_BASE_URL for OAuth redirect URIs).
An explicit admin.appBaseUrl always wins (the operator's own declared public
base URL is the most authoritative "how the outside world reaches this
release" value the chart has). When empty, falls back to
"<agent-platform.publicScheme>://<agent-platform.publicHost>", which only resolves a
host for networking.type=ingress/gateway; ClusterIP/NodePort/LoadBalancer
installs have no chart-known public URL and this renders "" (the caller
should `{{- if }}` on the result to decide whether to emit the env var).
*/}}
{{- define "agent-platform.admin.appBaseUrl" -}}
{{- if .Values.admin.appBaseUrl -}}
{{- .Values.admin.appBaseUrl -}}
{{- else -}}
{{- $publicHost := include "agent-platform.publicHost" . -}}
{{- if $publicHost -}}
{{- printf "%s://%s" (include "agent-platform.publicScheme" .) $publicHost -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Name of the PostgreSQL subchart Service / Secret ("<release>-postgresql").
The Bitnami subchart derives these from its own fullname (release name +
"postgresql"); with no postgresql.fullnameOverride this is the standard form.
*/}}
{{- define "agent-platform.postgresql.fullname" -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve the bundled PostgreSQL APPLICATION user's password (the account named by
postgresql.auth.username — NOT the postgres superuser). Resolution order:

  1. .Values.postgresql.auth.password when set explicitly, else
  2. postgresql.auth.existingSecret's "password" key, else
  3. the live "<release>-postgresql" Secret's "password" key (Bitnami
     auto-generated on first install), else
  4. "" — the case on `helm template` / helm-unittest, which do NOT execute
     `lookup`. A live install/upgrade resolves the real value.

KEY NAME: Bitnami postgresql 18.11.3 templates/secrets.yaml emits exactly
`postgres-password` (superuser), `password` (application user),
`replication-password` and `ldap-password`. It has NEVER emitted
`postgresql-password` — the key this chart previously looked up, which meant
branch 3 could never fire and a bundled-Postgres install rendered an
empty-password DSN unless postgresql.auth.password was set by hand.

CAVEAT (branch 3 on first install): the "<release>-postgresql" Secret does not
exist yet during `helm install`, so an auto-generated password still resolves to
"" on the very first render. Set postgresql.auth.password (or
auth.existingSecret) for a single-shot install — examples/values-minikube.yaml
does exactly that.
*/}}
{{- define "agent-platform.postgresql.password" -}}
{{- $password := .Values.postgresql.auth.password }}
{{- if not $password }}
{{- if .Values.postgresql.auth.existingSecret }}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace .Values.postgresql.auth.existingSecret) }}
{{- if and $secret $secret.data (index $secret.data "password") }}
{{- $password = (index $secret.data "password" | b64dec) }}
{{- end }}
{{- else }}
{{- $secret := (lookup "v1" "Secret" .Release.Namespace (include "agent-platform.postgresql.fullname" .)) }}
{{- if and $secret $secret.data (index $secret.data "password") }}
{{- $password = (index $secret.data "password" | b64dec) }}
{{- end }}
{{- end }}
{{- end }}
{{- $password }}
{{- end }}

{{/*
Assemble a bundled-PostgreSQL connection string for one database.

Usage: include "agent-platform.postgresql.dsn" (dict "context" . "database" "shipwright_chat")

Always rendered into a chart-managed Secret — never into plaintext Deployment
env — so the password does not appear in `kubectl get deploy -o yaml`.
*/}}
{{- define "agent-platform.postgresql.dsn" -}}
{{- $ctx := .context }}
{{- printf "postgresql://%s:%s@%s:5432/%s"
      $ctx.Values.postgresql.auth.username
      (include "agent-platform.postgresql.password" $ctx)
      (include "agent-platform.postgresql.fullname" $ctx)
      .database }}
{{- end }}

{{/*
agent-platform.cloudSqlProxy.container — the cloud-sql-proxy sidecar container
body (name/image/args/securityContext/resources), shared verbatim between the
admin/task-store/chat Deployments AND between the two render paths
(containers: today, initContainers: when cloudSqlProxy.nativeSidecar=true —
DBE-1.2) so all six call sites stay byte-identical instead of drifting.

Args: a dict with keys
  - context:       the root "." context (to reach .Values.cloudSqlProxy)
  - nativeSidecar: bool — when true, appends restartPolicy: Always, which is
    what makes this a Kubernetes native sidecar (initContainer that starts
    before and terminates AFTER the main containers, GA in Kubernetes 1.29+).
    Omit/false for the plain sidecar-container path (today's default output).

Caller is responsible for placement: under `containers:` for the default
(nativeSidecar=false) path, or under `initContainers:` — AFTER any
wait-for-postgres entry — when nativeSidecar=true. Emits a single list item
at the caller's `nindent 8` (matches every existing call site's indentation).
*/}}
{{- define "agent-platform.cloudSqlProxy.container" -}}
{{- $ctx := .context -}}
- name: cloud-sql-proxy
  image: {{ $ctx.Values.cloudSqlProxy.image }}
  args:
    - --private-ip
    - {{ required "cloudSqlProxy.connectionName is required when cloudSqlProxy.enabled=true" $ctx.Values.cloudSqlProxy.connectionName | quote }}
    {{- range $ctx.Values.cloudSqlProxy.args }}
    - {{ . | quote }}
    {{- end }}
  securityContext:
    runAsNonRoot: true
  {{- with $ctx.Values.cloudSqlProxy.resources }}
  resources:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- if .nativeSidecar }}
  restartPolicy: Always
  {{- end }}
{{- end }}

{{/*
Chat component fullname: "<fullname>-chat".
*/}}
{{- define "agent-platform.chat.fullname" -}}
{{- printf "%s-chat" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the chart-managed chat Secret (holds the assembled
DATABASE_URL_SHIPWRIGHT_CHAT on the bundled-PostgreSQL path).
*/}}
{{- define "agent-platform.chat.secretName" -}}
{{- printf "%s-chat" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the Secret holding the raw chat admin token, or "" when chat is
disabled. Prefers a caller-supplied chat.adminToken.existingSecret; otherwise
the chart manages the token itself in its own chat Secret (see
chat-secret.yaml). Both the chat container (CHAT_SEED_ADMIN_TOKEN) and the
admin container (SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN) resolve through this so
the two always read the same value — that shared value is what makes the admin
console's Chat tab work without a hand-created Secret.
*/}}
{{- define "agent-platform.chat.adminTokenSecretName" -}}
{{- if .Values.chat.enabled }}{{- .Values.chat.adminToken.existingSecret | default (include "agent-platform.chat.secretName" .) }}{{- end }}
{{- end }}

{{/*
Key within the chat admin-token Secret. One expression shared by the chart-managed
Secret and both consumers, so a custom chat.adminToken.key stays consistent.
*/}}
{{- define "agent-platform.chat.adminTokenSecretKey" -}}
{{- .Values.chat.adminToken.key | default "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN" }}
{{- end }}

{{/*
agent-platform.agent.claudePolicy.configMapName — name of the managed Claude Code
policy ConfigMap. Single source of truth shared by the ConfigMap and the admin
SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP env.
*/}}
{{- define "agent-platform.agent.claudePolicy.configMapName" -}}
{{- printf "%s-agent-claude-policy" (include "agent-platform.admin.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
agent-platform.agent.claudePolicy.json — managed-settings.json content (settings as
pretty JSON). Shared by the ConfigMap data and the admin policy hash env.
*/}}
{{- define "agent-platform.agent.claudePolicy.json" -}}
{{- .Values.agent.provisioning.claudePolicy.settings | toPrettyJson }}
{{- end }}

{{/*
agent-platform.validate.claudePolicy — the agent.provisioning.claudePolicy guards (check 7
above), split out so templates/agent-claude-policy-configmap.yaml can run just
these on every manifest render without re-running the ingress checks.
*/}}
{{- define "agent-platform.validate.claudePolicy" -}}
{{- if .Values.agent.provisioning.claudePolicy.enabled -}}
{{- if not .Values.agent.provisioning.enabled -}}
{{- fail "agent.provisioning.claudePolicy.enabled=true requires agent.provisioning.enabled=true — only provisioned agent pods consume the policy." -}}
{{- end -}}
{{- if not .Values.agent.provisioning.claudePolicy.settings -}}
{{- fail "agent.provisioning.claudePolicy.enabled=true requires non-empty agent.provisioning.claudePolicy.settings." -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
agent-platform.validate.anthropicFederation — the agent.provisioning.anthropicFederation
guards (check 8 above), split out so templates/admin-deployment.yaml can run just
these on every manifest render without re-running the ingress checks.
*/}}
{{- define "agent-platform.validate.anthropicFederation" -}}
{{- $fed := .Values.agent.provisioning.anthropicFederation -}}
{{- if $fed.enabled -}}
{{- if not .Values.agent.provisioning.enabled -}}
{{- fail "agent.provisioning.anthropicFederation.enabled=true requires agent.provisioning.enabled=true — only provisioned agent pods use federation." -}}
{{- end -}}
{{- if eq ($fed.identityMode | default "shared") "perAgent" -}}
{{- /* perAgent: each agent gets its own SA/identity, so the shared rule, service
account and agent ServiceAccount are not required — only the org, issuer and the
admin's own bootstrap federation. */ -}}
{{- range $field := list "organizationId" "issuerId" -}}
{{- if not (get $fed $field) -}}
{{- fail (printf "agent.provisioning.anthropicFederation.identityMode=perAgent requires a non-empty agent.provisioning.anthropicFederation.%s." $field) -}}
{{- end -}}
{{- end -}}
{{- range $field := list "ruleId" "serviceAccountId" -}}
{{- if not (get ($fed.adminFederation | default dict) $field) -}}
{{- fail (printf "agent.provisioning.anthropicFederation.identityMode=perAgent requires a non-empty agent.provisioning.anthropicFederation.adminFederation.%s." $field) -}}
{{- end -}}
{{- end -}}
{{- else -}}
{{- range $field := list "federationRuleId" "organizationId" "serviceAccountId" -}}
{{- if not (get $fed $field) -}}
{{- fail (printf "agent.provisioning.anthropicFederation.enabled=true requires a non-empty agent.provisioning.anthropicFederation.%s." $field) -}}
{{- end -}}
{{- end -}}
{{- if and (not .Values.agent.provisioning.serviceAccount.create) (not .Values.agent.provisioning.serviceAccount.name) -}}
{{- fail "agent.provisioning.anthropicFederation.enabled=true requires an agent ServiceAccount: set agent.provisioning.serviceAccount.create=true or a non-empty agent.provisioning.serviceAccount.name (federated tokens must not be issued to the namespace default ServiceAccount)." -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
