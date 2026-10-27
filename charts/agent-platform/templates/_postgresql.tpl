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
