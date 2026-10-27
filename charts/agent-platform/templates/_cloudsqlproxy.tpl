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
