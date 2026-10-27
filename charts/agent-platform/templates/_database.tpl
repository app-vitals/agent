{{/*
Bundled-PostgreSQL per-service database provisioning: the initdb ConfigMap
(first boot of an empty volume) and the post-install/post-upgrade bootstrap Job
that runs the same SQL on every release (covers already-initialized volumes).
*/}}

{{/*
Name of the ConfigMap holding the PostgreSQL first-boot initdb scripts.

LEGACY NAME — DO NOT CHANGE. Renders "<release>-metrics-initdb" even though the
ConfigMap creates every per-service database: the consumer's values reference
it statically via postgresql.primary.initdb.scriptsConfigMap (the Bitnami
subchart's tpl context is its own root, so the reference cannot be computed),
and operators who pinned that key would get a dangling volume if it changed.
*/}}
{{- define "agent-platform.postgresql.initdbConfigMapName" -}}
{{- printf "%s-metrics-initdb" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
agent-platform.postgresql.initdbConfigMap — the initdb scripts ConfigMap,
rendered whenever postgresql.enabled (the subchart's volume reference to it is
static, so it must exist whenever the subchart does).

One idempotent `CREATE DATABASE ... WHERE NOT EXISTS ... \gexec` script per
database, owned by postgresql.auth.username: one per extension `databases`
entry (see _components.tpl; `file` is the data key, `name` the database), then
the platform's chat database (02-create-chat-db.sql). The admin database is
postgresql.auth.database itself, created by the subchart. Scripts run in file
name order.
*/}}
{{- define "agent-platform.postgresql.initdbConfigMap" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if .Values.postgresql.enabled }}
{{- $owner := .Values.postgresql.auth.username }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "agent-platform.postgresql.initdbConfigMapName" . }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
data:
  {{- range ($ext.databases | default list) }}
  {{ .file }}: |
    SELECT 'CREATE DATABASE {{ .name }} OWNER {{ $owner }}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{{ .name }}')\gexec
  {{- end }}
  02-create-chat-db.sql: |
    {{- $db := include "agent-platform.chat.databaseName" . }}
    SELECT 'CREATE DATABASE {{ $db }} OWNER {{ $owner }}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{{ $db }}')\gexec
{{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.postgresql.dbBootstrapJob — post-install/post-upgrade hook Job
(postgresql.enabled AND dbBootstrap.enabled) that applies every script in the
initdb ConfigMap against the bundled PostgreSQL as the superuser (CREATE
DATABASE needs it). initdb scripts only run on an empty volume, so without this
Job a database added on an existing release would never be created. Hook weight
-5 runs it before default-weight hooks; it polls pg_isready first. Reuses the
PostgreSQL subchart's image so no extra pull is needed.
*/}}
{{- define "agent-platform.postgresql.dbBootstrapJob" -}}
{{- if and .Values.postgresql.enabled .Values.dbBootstrap.enabled }}
{{- $pgFullname := include "agent-platform.postgresql.fullname" . }}
{{- $secretName := .Values.postgresql.auth.existingSecret | default $pgFullname }}
{{- /* dig is nil-safe: postgresql.auth.secretKeys may be absent from the parent's
       merged values view depending on how the subchart's defaults coalesce. */}}
{{- $secretKey := dig "secretKeys" "adminPasswordKey" "postgres-password" .Values.postgresql.auth }}
{{- $secretKey = $secretKey | default "postgres-password" }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ printf "%s-db-bootstrap" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: db-bootstrap
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: {{ .Values.dbBootstrap.backoffLimit }}
  template:
    metadata:
      labels:
        {{- include "agent-platform.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: db-bootstrap
    spec:
      restartPolicy: Never
      {{- with .Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
      containers:
        - name: db-bootstrap
          # Reuse the PostgreSQL subchart's own image so this Job never triggers
          # an extra image pull — it is already on the node for the database pod.
          image: {{ include "agent-platform.imageRef" (dict "context" . "repository" (printf "%s/%s" .Values.postgresql.image.registry .Values.postgresql.image.repository) "tag" .Values.postgresql.image.tag "digest" .Values.postgresql.image.digest) | quote }}
          imagePullPolicy: {{ .Values.postgresql.image.pullPolicy | default .Values.imagePullPolicy }}
          env:
            - name: PGHOST
              value: {{ $pgFullname | quote }}
            - name: PGPORT
              value: "5432"
            - name: PGUSER
              value: postgres
            - name: PGDATABASE
              value: postgres
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ $secretName }}
                  key: {{ $secretKey }}
          command:
            - /bin/sh
            - -ec
            - |
              echo "[db-bootstrap] waiting for postgresql at $PGHOST:$PGPORT ..."
              until pg_isready -q; do sleep 2; done
              echo "[db-bootstrap] connected; ensuring per-service databases exist"
              for f in /initdb/*.sql; do
                echo "[db-bootstrap] applying $(basename "$f")"
                psql -v ON_ERROR_STOP=1 --no-psqlrc -f "$f"
              done
              echo "[db-bootstrap] done"
          volumeMounts:
            - name: initdb
              mountPath: /initdb
              readOnly: true
          {{- with .Values.dbBootstrap.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: initdb
          configMap:
            name: {{ include "agent-platform.postgresql.initdbConfigMapName" . }}
{{- end }}
{{- end }}
