{{/*
Shipwright's extension lists for the library's shared networking, database and
NOTES templates — the coding services (metrics, task-store) the platform does
not own. Mirrors what the shipwright chart supplies, so the fixture renders the
same objects as that chart. Rendered as YAML and passed through `fromYaml` by
each stub. Test-only values: `fixture.platformOnly=true` supplies no
extensions; a non-empty `fixture.extensions` is passed through verbatim instead
of Shipwright's lists.
*/}}
{{- define "shipwright.platformExtensions" -}}
{{- if .Values.fixture.platformOnly }}
{{- else if .Values.fixture.extensions }}
{{- toYaml .Values.fixture.extensions }}
{{- else }}
routes:
{{- if .Values.metrics.enabled }}
  - component: metrics
    pathPrefix: /dashboard
    port: {{ .Values.metrics.service.port }}
{{- end }}
{{- if and .Values.taskStore.enabled .Values.taskStore.expose.enabled }}
  - component: task-store
    pathPrefix: {{ .Values.taskStore.expose.pathPrefix | toJson }}
    port: {{ .Values.taskStore.service.port }}
    stripPrefix: true
{{- end }}
healthChecks:
{{- if .Values.metrics.enabled }}
  - component: metrics
{{- end }}
{{- if .Values.taskStore.enabled }}
  - component: task-store
{{- end }}
networkPolicyEgress:
  - component: task-store
databases:
  - file: 00-create-metrics-db.sql
    name: {{ include "shipwright.metrics.databaseName" . | toJson }}
  - file: 01-create-task-store-db.sql
    name: {{ include "shipwright.taskStore.databaseName" . | toJson }}
notes:
  productName: Shipwright Harness
  servicePorts:
    - name: metrics
      port: {{ .Values.metrics.service.port }}
    {{- if .Values.taskStore.enabled }}
    - name: task-store
      port: {{ .Values.taskStore.service.port }}
    {{- end }}
  sections:
    {{- if .Values.metrics.enabled }}
    - {{ include "shipwright.notes.metrics" . | toJson }}
    {{- end }}
    {{- if .Values.taskStore.enabled }}
    - {{ include "shipwright.notes.taskStore" . | toJson }}
    {{- end }}
{{- end }}
{{- end }}

{{- define "shipwright.metrics.databaseName" -}}
{{- default "shipwright_metrics" .Values.metrics.database.name }}
{{- end }}

{{- define "shipwright.taskStore.databaseName" -}}
{{- default "shipwright_task_store" .Values.taskStore.database.name }}
{{- end }}

{{- define "shipwright.notes.metrics" -}}
Metrics dashboard access:
  The metrics Deployment listens on port 3460 (health check: GET /health).
  Reach the dashboard from your workstation:
    kubectl port-forward svc/{{ include "agent-platform.fullname" . }}-metrics 3460:{{ .Values.metrics.service.port }} -n {{ .Release.Namespace }}
  then open http://localhost:3460/dashboard
{{- if .Values.postgresql.enabled }}
  METRICS_DATABASE_URL is assembled into the chart-managed Secret
  "{{ include "agent-platform.fullname" . }}-metrics" (postgres mode against the bundled
  PostgreSQL, database "{{ include "shipwright.metrics.databaseName" . }}"), so the
  database password never appears in the Deployment's plaintext env.
{{- else }}
  PostgreSQL subchart is disabled — set METRICS_DATABASE_URL yourself (e.g. via a
  pre-created Secret) so the metrics service can reach your event store. Leaving
  it unset does NOT fall back to a working local store: the published image has
  no writable SQLite path and the pod crashes on boot with SQLITE_CANTOPEN.
{{- end }}
{{- end }}

{{- define "shipwright.notes.taskStore" -}}
Task-store access:
  kubectl port-forward svc/{{ include "agent-platform.fullname" . }}-task-store 3000:{{ .Values.taskStore.service.port }} -n {{ .Release.Namespace }}
  then: curl http://localhost:3000/health
{{- if and (not .Values.taskStore.database.existingSecret) .Values.postgresql.enabled }}
  Using the bundled PostgreSQL, database "{{ include "shipwright.taskStore.databaseName" . }}".
{{- else }}
  Using the pre-existing Secret "{{ .Values.taskStore.database.existingSecret }}" for
  DATABASE_URL_SHIPWRIGHT_TASK_STORE — the chart does not manage it.
{{- end }}
{{- end }}
