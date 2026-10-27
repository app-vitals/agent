{{/*
agent-platform.notes — the release NOTES.txt body. A consumer's NOTES.txt is the
one-line `{{ include "agent-platform.notes" (dict "context" . "extensions" $ext) }}`.

Runs agent-platform.validate first: NOTES.txt is excluded from `helm template`
manifest output and from manifest-shaped helm-unittest targets, so this is where
"fail fast on bad values" surfaces on `helm install`/`helm upgrade` without
changing any manifest.

Extension `notes` (see _components.tpl): productName is shown after the chart
name in the banner; servicePorts lines and sections (free text, one block per
entry, separated by a blank line) render between the admin and chat entries.
*/}}
{{- define "agent-platform.notes" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- $notes := $ext.notes | default dict }}
{{- with $ctx }}
{{- include "agent-platform.validate" . }}
Thank you for installing {{ .Chart.Name }}{{ with $notes.productName }} ({{ . }}){{ end }} — chart version {{ .Chart.Version }}, app version {{ .Chart.AppVersion }}.

What this release provisions:

  Agents are NOT a Deployment in this chart — the admin service provisions them
  at runtime (enable with agent.provisioning.enabled). Create your first agent
  from the admin console once the pods are up.


{{- if .Values.postgresql.enabled }}
  • PostgreSQL (Bitnami subchart) — database "{{ .Values.postgresql.auth.database }}", user "{{ .Values.postgresql.auth.username }}".
    Connect from inside the cluster:
      Host:     {{ .Release.Name }}-postgresql.{{ .Release.Namespace }}.svc.cluster.local
      Port:     5432
{{- if not .Values.postgresql.auth.existingSecret }}
    Retrieve the password:
      kubectl get secret --namespace {{ .Release.Namespace }} {{ .Release.Name }}-postgresql \
        -o jsonpath="{.data.password}" | base64 -d
{{- end }}
{{- else }}
  • PostgreSQL subchart is DISABLED. Point the admin service at an external
    DATABASE_URL_SHIPWRIGHT_ADMIN connection string.
{{- end }}

Configured service ports:
  • admin:      {{ .Values.admin.service.port }}
{{- range ($notes.servicePorts | default list) }}
  • {{ printf "%-12s" (printf "%s:" .name) }}{{ .port }}
{{- end }}
{{- if .Values.chat.enabled }}
  • chat:       {{ .Values.chat.service.port }}
{{- end }}

Networking exposure type: {{ .Values.networking.type }}
Auth mode:                {{ .Values.auth.mode }}
{{- $publicUrl := include "agent-platform.admin.appBaseUrl" . }}
{{- if $publicUrl }}
Public URL:               {{ $publicUrl }}
{{- end }}
{{- if or (index .Values "ingress-nginx" "enabled") .Values.traefik.enabled (index .Values "cert-manager" "enabled") }}

Bundled subcharts (this release deploys these alongside the app):
{{- if index .Values "ingress-nginx" "enabled" }}
  • ingress-nginx — bundled as this release's ingress controller.
{{- end }}
{{- if .Values.traefik.enabled }}
  • traefik       — bundled as this release's ingress controller.
{{- end }}
{{- if index .Values "cert-manager" "enabled" }}
  • cert-manager  — bundled to issue TLS certificates for this release.
{{- end }}
{{- end }}

{{- if .Values.admin.enabled }}

Admin service access:
  The admin Deployment listens on port 3001 (health check: GET /health).
  Reach the UI/API from your workstation:
    kubectl port-forward svc/{{ include "agent-platform.admin.fullname" . }} 3001:{{ .Values.admin.service.port }} -n {{ .Release.Namespace }}
  then open http://localhost:3001
{{- if .Values.postgresql.enabled }}
  DATABASE_URL_SHIPWRIGHT_ADMIN is assembled into the chart-managed Secret
  "{{ include "agent-platform.admin.secretName" . }}" (pointing at the bundled PostgreSQL),
  so the database password never appears in the Deployment's plaintext env.
{{- else }}
  PostgreSQL subchart is disabled — set DATABASE_URL_SHIPWRIGHT_ADMIN yourself
  (e.g. via a pre-created Secret) so the admin service can reach your database.
{{- end }}
  The session/encryption keys (SHIPWRIGHT_SESSION_SECRET / _ENCRYPTION_KEY) are
  generated into that Secret on first install and PRESERVED across `helm upgrade`.
{{- end }}
{{- range ($notes.sections | default list) }}

{{ . | trimAll "\n" }}
{{- end }}

{{- if .Values.chat.enabled }}

Chat service access:
  kubectl port-forward svc/{{ include "agent-platform.chat.fullname" . }} 3000:{{ .Values.chat.service.port }} -n {{ .Release.Namespace }}
  then: curl http://localhost:3000/health
{{- if include "agent-platform.chat.useBundledDatabase" . }}
  Using the bundled PostgreSQL, database "{{ include "agent-platform.chat.databaseName" . }}".
{{- else }}
  Using the pre-existing Secret "{{ .Values.chat.database.existingSecret }}" for
  DATABASE_URL_SHIPWRIGHT_CHAT — the chart does not manage it.
{{- end }}
{{- end }}

{{- if .Values.agent.provisioning.enabled }}

Provision your first agent:
  No agent exists yet — agents are created at runtime, not by this chart.
  Open the admin console and create one at /admin/agents/new. Set its Claude
  credential (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) there — this chart
  does not provision deployment-wide Claude credentials.
{{- end }}

{{- if and .Values.admin.enabled (eq .Values.auth.mode "open") }}

  ============================================================================
  ⚠️  WARNING: auth.mode=open — DEV AUTH ONLY, NO REAL AUTHENTICATION.
      ADMIN_DEV_AUTH=true is set: anyone who can reach the admin service is
      treated as authenticated. This is INSECURE. DO NOT expose this service
      publicly (no public LoadBalancer/Ingress). For real access control set
      auth.mode=google and provide auth.google.{clientId,clientSecret,allowedEmails}.
  ============================================================================
{{- else if eq .Values.auth.mode "google" }}

  auth.mode=google — Google OAuth is enabled (NODE_ENV=production). Only emails
  in auth.google.allowedEmails ("{{ .Values.auth.google.allowedEmails }}") may sign in.
{{- else if eq .Values.auth.mode "okta" }}

  ============================================================================
  ⚠️  WARNING: auth.mode=okta is CHART-ONLY — the admin app has no Okta login
      handler yet. NODE_ENV=production is set (blocking dev-auth) with no
      working login path, which will lock you out of the admin UI. Use
      auth.mode=google (working today) or auth.mode=open (non-public only)
      until application-side Okta support ships.
  ============================================================================
{{- end }}
{{- /*
Let's Encrypt STAGING warning (chart-managed Issuer only — a bring-your-own
Issuer is opaque here). Staging certs are not publicly trusted.
*/}}
{{- if and .Values.tls.certManager.issuer.create (eq .Values.tls.certManager.issuer.type "letsencrypt") (contains "acme-staging" .Values.tls.certManager.issuer.server) }}

  ============================================================================
  ⚠️  WARNING: tls.certManager.issuer.server points at the Let's Encrypt
      STAGING endpoint ({{ .Values.tls.certManager.issuer.server }}).
      Staging certificates are NOT publicly trusted — browsers and most HTTP
      clients will reject them. This is expected while testing (staging has
      much higher rate limits than production), but switch
      tls.certManager.issuer.server to the production endpoint (or leave it
      empty for the chart's own default) before relying on this for real
      traffic.
  ============================================================================
{{- end }}

Minikube tip: with networking.type=ClusterIP, reach a service via
  kubectl port-forward svc/<service> <localPort>:<servicePort> -n {{ .Release.Namespace }}

Image registry note: if the pinned Bitnami PostgreSQL digest becomes unavailable,
set global.imageRegistry (or postgresql.image.registry/repository/digest) to a mirror.
See the chart README "Bitnami registry risk" section for details.
{{- end }}
{{- end }}
