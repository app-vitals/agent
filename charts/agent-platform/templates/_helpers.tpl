{{/*
Expand the name of the chart.
*/}}
{{- define "agent-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec). If release name contains chart name it will be used as a
full name.
*/}}
{{- define "agent-platform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "agent-platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agent-platform.labels" -}}
helm.sh/chart: {{ include "agent-platform.chart" . }}
{{ include "agent-platform.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "agent-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Operator-supplied extra pod-template labels for a workload.

Renders a workload's `podLabels` value as YAML, with that workload's own
selector labels protected: a key that collides with a selector label is
dropped rather than emitted, so values can never desync a pod template from
the Deployment's immutable `spec.selector`. Values are coerced to strings —
Kubernetes label values are strings, and an unquoted `true` in values.yaml
would otherwise render a bool the API server rejects.

Emits nothing at all when there is nothing left to add, so the default
(`podLabels: {}`) render is byte-identical to a chart without this hook.

Usage:
  {{- with (include "agent-platform.podLabels" (dict "podLabels" .Values.admin.podLabels "selectorLabels" $selectorLabels)) }}
  {{- . | nindent 8 }}
  {{- end }}
*/}}
{{- define "agent-platform.podLabels" -}}
{{- $reserved := keys (fromYaml .selectorLabels) -}}
{{- $extra := dict -}}
{{- range $key, $value := (.podLabels | default dict) -}}
{{- if not (has $key $reserved) -}}
{{- $_ := set $extra $key (toString $value) -}}
{{- end -}}
{{- end -}}
{{- if $extra -}}
{{- toYaml $extra -}}
{{- end -}}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "agent-platform.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent-platform.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Assemble a container image reference, applying global.imageRegistry only when it
is safe to do so.

Args: a dict with keys
  - context:    the root "." context (to reach .Values.global.imageRegistry)
  - repository: the image repository (may be bare or fully-qualified)
  - tag:        the image tag
  - digest:     (optional) an immutable image digest ("sha256:..."). When set,
                takes precedence over tag and the reference uses "@" instead
                of ":" as the separator — same convention as bitnami-common's
                own common.images.image helper.

DCC-3.1: the shipwright service repositories default to fully-qualified GHCR
paths (e.g. ghcr.io/app-vitals/shipwright-admin). Blindly prefixing
global.imageRegistry onto those would DOUBLE-prefix them
(registry/ghcr.io/app-vitals/...). Following the standard Helm/OCI community
convention, a repository is treated as already naming a registry host when its
first "/"-delimited segment contains a "." or ":" (e.g. "ghcr.io",
"docker.io", "localhost:5000"). Such fully-qualified repositories are rendered
verbatim; only BARE repository names (e.g. a user-overridden "shipwright-admin")
receive the global.imageRegistry prefix.
*/}}
{{- define "agent-platform.imageRef" -}}
{{- $registry := .context.Values.global.imageRegistry -}}
{{- $repository := .repository -}}
{{- $separator := ":" -}}
{{- $termination := .tag -}}
{{- if .digest -}}
{{- $separator = "@" -}}
{{- $termination = .digest -}}
{{- end -}}
{{- $firstSegment := $repository | splitList "/" | first -}}
{{- if and $registry (not (or (contains "." $firstSegment) (contains ":" $firstSegment))) -}}
{{- printf "%s/%s%s%s" $registry $repository $separator $termination -}}
{{- else -}}
{{- printf "%s%s%s" $repository $separator $termination -}}
{{- end -}}
{{- end }}

{{/*
Admin component fullname: "<fullname>-admin".
*/}}
{{- define "agent-platform.admin.fullname" -}}
{{- printf "%s-admin" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Admin selector labels — fullname selector labels plus the component label.
*/}}
{{- define "agent-platform.admin.selectorLabels" -}}
{{ include "agent-platform.selectorLabels" . }}
app.kubernetes.io/component: admin
{{- end }}

{{/*
Admin labels — common labels plus the component label.
*/}}
{{- define "agent-platform.admin.labels" -}}
{{ include "agent-platform.labels" . }}
app.kubernetes.io/component: admin
{{- end }}

{{/*
Name of the ServiceAccount the admin workload uses.
*/}}
{{- define "agent-platform.admin.serviceAccountName" -}}
{{- if .Values.admin.serviceAccount.create }}
{{- default (include "agent-platform.admin.fullname" .) .Values.admin.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.admin.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed admin Secret (session + encryption keys, and the
assembled DATABASE_URL when the bundled PostgreSQL subchart is used).
*/}}
{{- define "agent-platform.admin.secretName" -}}
{{- printf "%s-admin" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Agent component fullname: "<fullname>-agent".
*/}}
{{- define "agent-platform.agent.fullname" -}}
{{- printf "%s-agent" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Agent labels — common labels plus the component label.
*/}}
{{- define "agent-platform.agent.labels" -}}
{{ include "agent-platform.labels" . }}
app.kubernetes.io/component: agent
{{- end }}

{{/*
Name of the ServiceAccount provisioned agent pods run as (SEPARATE from the admin
SA). Defaults to "<fullname>-agent" when create=true and no name override.
*/}}
{{- define "agent-platform.agent.serviceAccountName" -}}
{{- if .Values.agent.provisioning.serviceAccount.create }}
{{- default (include "agent-platform.agent.fullname" .) .Values.agent.provisioning.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.agent.provisioning.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Whisper component fullname: "<fullname>-whisper". The self-hosted Whisper ASR
pod (onerahmet/openai-whisper-asr-webservice) rendered only when
agent.voice.enabled and agent.voice.provider == "whisper".
*/}}
{{- define "agent-platform.whisper.fullname" -}}
{{- printf "%s-whisper" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Whisper selector labels — fullname selector labels plus the component label.
*/}}
{{- define "agent-platform.whisper.selectorLabels" -}}
{{ include "agent-platform.selectorLabels" . }}
app.kubernetes.io/component: whisper
{{- end }}

{{/*
Whisper labels — common labels plus the component label.
*/}}
{{- define "agent-platform.whisper.labels" -}}
{{ include "agent-platform.labels" . }}
app.kubernetes.io/component: whisper
{{- end }}

{{/*
In-cluster URL of the Whisper Service ("http://<fullname>-whisper:<port>").
This is the WHISPER_SERVICE_URL injected into the admin (and via the provisioner,
provisioned agents) when agent.voice.provider == "whisper".
*/}}
{{- define "agent-platform.whisper.serviceUrl" -}}
{{- printf "http://%s:%v" (include "agent-platform.whisper.fullname" .) .Values.agent.voice.whisper.service.port }}
{{- end }}

{{/*
Name of the chart-managed voice Secret holding the STT/TTS API keys
(ELEVENLABS_API_KEY, and GROQ_API_KEY when provider=groq).
*/}}
{{- define "agent-platform.voice.secretName" -}}
{{- printf "%s-voice" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
